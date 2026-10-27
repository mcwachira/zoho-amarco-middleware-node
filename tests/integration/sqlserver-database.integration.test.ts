import "dotenv/config";

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { SqlServerFiscalizationRepository } from "../../src/infrastructure/database/sqlserver-fiscalization-repository.js";
import { SqlServerFiscalCustomerProfileRepository } from "../../src/infrastructure/database/sqlserver-fiscal-customer-profile-repository.js";
import { SqlServerFiscalItemProfileRepository } from "../../src/infrastructure/database/sqlserver-fiscal-item-profile-repository.js";
import { SqlServerZohoOAuthAttemptRepository } from "../../src/infrastructure/database/sqlserver-zoho-oauth-attempt-repository.js";
import { SqlServerZohoTokenRepository } from "../../src/infrastructure/database/sqlserver-zoho-token-repository.js";
import { SqlServerZohoSyncRepository } from "../../src/infrastructure/database/sqlserver-zoho-sync-repository.js";
import { createSqlServerClient } from "../../src/infrastructure/database/sqlserver-client.js";

const integrationEnabled = process.env["RUN_SQLSERVER_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

const testDatabaseNamePattern = /^zoho_amarco_sqlserver_test(?:_[a-z0-9]+)?$/;

function getTestConnection() {
  const server = process.env["SQLSERVER_TEST_SERVER"]?.trim();
  const database = process.env["SQLSERVER_TEST_DATABASE"]?.trim();
  const user = process.env["SQLSERVER_TEST_USER"]?.trim();
  const password = process.env["SQLSERVER_TEST_PASSWORD"];
  const port = Number(process.env["SQLSERVER_TEST_PORT"] ?? "1433");

  if (
    !server ||
    !database ||
    !user ||
    !password ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Explicit SQL Server integration-test connection settings are required.");
  }

  if (!["localhost", "127.0.0.1"].includes(server)) {
    throw new Error("SQL Server integration tests are restricted to a local server.");
  }

  if (!testDatabaseNamePattern.test(database)) {
    throw new Error(
      "SQL Server integration tests require a database named zoho_amarco_sqlserver_test or its suffixed variant.",
    );
  }

  if ([server, database, user, password].some((value) => /[;\r\n]/.test(value))) {
    throw new Error(
      "SQL Server integration-test connection values contain unsupported delimiters.",
    );
  }

  return {
    server,
    database,
    user,
    password,
    port,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    migrationUrl:
      `sqlserver://${server}:${port};database=${database};user=${user};password=${password};` +
      "encrypt=true;trustServerCertificate=true",
  };
}

integrationDescribe("SQL Server migrations and repositories (integration)", () => {
  let prisma: ReturnType<typeof createSqlServerClient>;
  let fiscalizationRepository: SqlServerFiscalizationRepository;
  let customerRepository: SqlServerFiscalCustomerProfileRepository;
  let itemRepository: SqlServerFiscalItemProfileRepository;
  let oauthAttemptRepository: SqlServerZohoOAuthAttemptRepository;
  let tokenRepository: SqlServerZohoTokenRepository;
  let syncRepository: SqlServerZohoSyncRepository;

  const invoiceIds: string[] = [];
  const customerIds: string[] = [];
  const itemIds: string[] = [];
  const stateHashes: string[] = [];
  const syncOrganizationIds: string[] = [];
  const syncRunIds: string[] = [];

  beforeAll(async () => {
    const connection = getTestConnection();
    const preMigrationClient = createSqlServerClient(connection);

    try {
      await preMigrationClient.$connect();
      const tables = await preMigrationClient.$queryRaw<{ name: string }[]>`
        SELECT [name] FROM [sys].[tables] WHERE [is_ms_shipped] = 0
      `;

      if (tables.length > 0) {
        throw new Error(
          "SQL Server fresh-install integration requires an empty dedicated test database.",
        );
      }
    } finally {
      await preMigrationClient.$disconnect();
    }

    try {
      execFileSync(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--schema", "prisma/sqlserver/schema.prisma"],
        {
          shell: process.platform === "win32",
          stdio: "ignore",
          env: {
            ...process.env,
            DATABASE_URL: connection.migrationUrl,
            PRISMA_SCHEMA: "prisma/sqlserver/schema.prisma",
            PRISMA_MIGRATIONS_PATH: "prisma/sqlserver/migrations",
          },
        },
      );
    } catch {
      throw new Error("SQL Server migrations failed on the dedicated empty integration database.");
    }

    prisma = createSqlServerClient(connection);
    await prisma.$connect();

    const expectedTables = [
      "FiscalizationRecord",
      "FiscalCustomerProfile",
      "FiscalItemProfile",
      "ZohoOAuthAttempt",
      "ZohoToken",
      "ZohoSyncRun",
      "ZohoSyncLock",
      "_prisma_migrations",
    ];
    const migratedTables = await prisma.$queryRaw<{ name: string }[]>`
      SELECT [name] FROM [sys].[tables] WHERE [is_ms_shipped] = 0
    `;
    const tableNames = new Set(migratedTables.map((table) => table.name));

    for (const table of expectedTables) {
      if (!tableNames.has(table)) {
        throw new Error(`SQL Server migration did not create required table ${table}.`);
      }
    }

    fiscalizationRepository = new SqlServerFiscalizationRepository(prisma);
    customerRepository = new SqlServerFiscalCustomerProfileRepository(prisma);
    itemRepository = new SqlServerFiscalItemProfileRepository(prisma);
    oauthAttemptRepository = new SqlServerZohoOAuthAttemptRepository(prisma);
    tokenRepository = new SqlServerZohoTokenRepository(prisma);
    syncRepository = new SqlServerZohoSyncRepository(prisma);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) {
      return;
    }

    if (invoiceIds.length > 0) {
      await prisma.fiscalizationRecord.deleteMany({
        where: { zohoInvoiceId: { in: invoiceIds } },
      });
    }
    if (customerIds.length > 0) {
      await prisma.fiscalCustomerProfile.deleteMany({
        where: { zohoCustomerId: { in: customerIds } },
      });
    }
    if (itemIds.length > 0) {
      await prisma.fiscalItemProfile.deleteMany({ where: { zohoItemId: { in: itemIds } } });
    }
    if (stateHashes.length > 0) {
      await prisma.zohoOAuthAttempt.deleteMany({ where: { stateHash: { in: stateHashes } } });
    }

    await prisma.zohoToken.deleteMany({ where: { id: "primary" } });
    if (syncRunIds.length > 0) {
      await prisma.zohoSyncRun.deleteMany({ where: { id: { in: syncRunIds } } });
    }
    if (syncOrganizationIds.length > 0) {
      await prisma.zohoSyncLock.deleteMany({
        where: { organizationId: { in: syncOrganizationIds } },
      });
    }

    await prisma.$disconnect();
  });

  it("persists immutable snapshots, enforces invoice uniqueness, and atomically claims once", async () => {
    const invoiceId = `sqlserver-invoice-${randomUUID()}`;
    invoiceIds.push(invoiceId);
    const record = createFiscalizationRecord({
      id: `sqlserver-record-${randomUUID()}`,
      zohoInvoiceId: invoiceId,
      snapshot: {
        schemaVersion: 1,
        snapshotId: randomUUID(),
        registeredAt: new Date().toISOString(),
        zohoOrganizationId: "integration-organization",
        invoice: {
          zohoInvoiceId: invoiceId,
          invoiceNumber: "SQL-TEST-1",
          customerId: "sqlserver-customer",
          customerName: "SQL Server test",
          currencyCode: "KES",
          lines: [
            {
              sourceLineId: "line-1",
              itemId: "item-1",
              description: "Test item",
              quantity: "1",
              unitPrice: "100",
              lineTotal: "100",
              taxId: null,
              taxName: null,
              taxType: null,
              taxPercentage: null,
            },
          ],
          subtotal: "100",
          taxTotal: "0",
          total: "100",
        },
        customer: {
          zohoCustomerId: "sqlserver-customer",
          companyName: "Test Company",
          clientPin: "P051234567X",
          headquarters: "Nairobi",
          address: "Test Road",
          postalCodeAndCity: "00100 Nairobi",
          exemptionNumber: null,
          traderSystemInvoiceNumber: invoiceId.slice(0, 15),
        },
        lineProfiles: [
          {
            sourceLineId: "line-1",
            zohoItemId: "item-1",
            measureUnit: "EA",
            hsCode: "1234.56.78",
            hsName: "Test item",
            vatClass: "A",
            vatGroupRate: "16",
          },
        ],
      },
    });

    await fiscalizationRepository.create(record);
    const stored = await fiscalizationRepository.findById(record.id);

    expect(stored?.snapshot).toEqual(record.snapshot);
    expect(stored?.snapshotVersion).toBe(1);

    const duplicate = createFiscalizationRecord({
      id: `sqlserver-record-${randomUUID()}`,
      zohoInvoiceId: invoiceId,
    });
    await expect(fiscalizationRepository.create(duplicate)).rejects.toBeInstanceOf(
      DuplicateZohoInvoiceError,
    );

    const claims = await Promise.all([
      fiscalizationRepository.claimPending(record.id),
      fiscalizationRepository.claimPending(record.id),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect((await fiscalizationRepository.findById(record.id))?.status).toBe("InProgress");
  });

  it("creates, reads, and updates fiscal customer and item profiles", async () => {
    const customerId = `sqlserver-customer-${randomUUID()}`;
    const itemId = `sqlserver-item-${randomUUID()}`;
    customerIds.push(customerId);
    itemIds.push(itemId);

    const customer = await customerRepository.create({
      zohoCustomerId: customerId,
      companyName: "Test Company",
      clientPin: "P051234567X",
      headquarters: "Nairobi",
      address: "Test Road",
      postalCodeAndCity: "00100 Nairobi",
      exemptionNumber: null,
    });
    const item = await itemRepository.create({
      zohoItemId: itemId,
      measureUnit: "EA",
      hsCode: "1234.56.78",
      hsName: "Test item",
      vatClass: "A",
      vatGroupRate: "16",
    });

    expect(await customerRepository.findByZohoCustomerId(customerId)).toMatchObject(customer);
    expect(await itemRepository.findByZohoItemId(itemId)).toMatchObject(item);

    const updatedCustomer = await customerRepository.update(customerId, {
      companyName: "Updated Company",
      clientPin: "P051234567X",
      headquarters: "Mombasa",
      address: "New Road",
      postalCodeAndCity: "80100 Mombasa",
      exemptionNumber: null,
    });
    const updatedItem = await itemRepository.update(itemId, {
      measureUnit: "KG",
      hsCode: "1234.56.78",
      hsName: "Updated item",
      vatClass: "A",
      vatGroupRate: "16",
    });

    expect(updatedCustomer.companyName).toBe("Updated Company");
    expect(updatedItem.measureUnit).toBe("KG");
  });

  it("enforces unique OAuth state, atomically consumes it, and persists the token singleton", async () => {
    const stateHash = randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64);
    stateHashes.push(stateHash);
    const now = new Date();
    await oauthAttemptRepository.create({
      stateHash,
      encryptedCodeVerifier: "synthetic-encrypted-verifier",
      expiresAt: new Date(now.getTime() + 60_000),
    });

    await expect(
      oauthAttemptRepository.create({
        stateHash,
        encryptedCodeVerifier: "another-synthetic-verifier",
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    const consumed = await Promise.all([
      oauthAttemptRepository.consume(stateHash, now),
      oauthAttemptRepository.consume(stateHash, now),
    ]);
    expect(consumed.filter((attempt) => attempt !== null)).toHaveLength(1);

    expect(await tokenRepository.get()).toBeNull();
    await tokenRepository.save({
      encryptedAccessToken: "synthetic-encrypted-access",
      encryptedRefreshToken: "synthetic-encrypted-refresh",
      accessTokenExpiresAt: new Date(now.getTime() + 3_600_000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });
    expect(await tokenRepository.get()).toMatchObject({
      encryptedAccessToken: "synthetic-encrypted-access",
      encryptedRefreshToken: "synthetic-encrypted-refresh",
    });

    it("persists synchronization history and enforces organization-scoped expiring leases", async () => {
      const organizationId = `it-sync-${randomUUID()}`;
      const runId = `it-sync-run-${randomUUID()}`;
      syncOrganizationIds.push(organizationId);
      syncRunIds.push(runId);
      const startedAt = new Date();
      const leaseExpiresAt = new Date(startedAt.getTime() + 60_000);

      const acquisitions = await Promise.all([
        syncRepository.tryAcquire(organizationId, "lease-first", startedAt, leaseExpiresAt),
        syncRepository.tryAcquire(
          organizationId,
          "lease-second",
          startedAt,
          new Date(startedAt.getTime() + 120_000),
        ),
      ]);
      expect(acquisitions.filter(Boolean)).toHaveLength(1);
      const winningToken = acquisitions[0] ? "lease-first" : "lease-second";
      expect(acquisitions[0]).not.toBe(acquisitions[1]);
      await syncRepository.createRun({ id: runId, organizationId, startedAt });
      await syncRepository.completeRun(runId, {
        status: "Succeeded",
        completedAt: leaseExpiresAt,
        discovered: 3,
        imported: 2,
        duplicatesSkipped: 1,
        rejected: 0,
        failed: 0,
        pagesRetrieved: 1,
        paginationComplete: true,
        errorCode: null,
      });

      const status = await syncRepository.getLatest(organizationId);
      expect(status.run).toMatchObject({
        id: runId,
        status: "Succeeded",
        discovered: 3,
        imported: 2,
        paginationComplete: true,
      });
      expect(status.lastSuccessfulRun?.completedAt).toEqual(leaseExpiresAt);
      expect(
        await syncRepository.renew(
          organizationId,
          winningToken,
          leaseExpiresAt,
          new Date(leaseExpiresAt.getTime() + 60_000),
        ),
      ).toBe(false);
    });
  });
});
