import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { completeFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlFiscalizationRepository } from "../../src/infrastructure/database/postgresql-fiscalization-repository.js";
import { PostgresqlFiscalCustomerProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-item-profile-repository.js";
import { PostgresqlZohoSyncRepository } from "../../src/infrastructure/database/postgresql-zoho-sync-repository.js";
import { makeFiscalizationSnapshot } from "../unit/fiscalization-snapshot-fixture.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";

const integrationEnabled = process.env["RUN_POSTGRES_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("PostgreSQL fiscalization repository (integrations)", () => {
  const testInvoiceIds: string[] = [];
  const testCustomerIds: string[] = [];
  const testItemIds: string[] = [];
  const syncOrganizationIds: string[] = [];
  const syncRunIds: string[] = [];

  let prisma: ReturnType<typeof createPostgresqlClient>;
  let repository: PostgresqlFiscalizationRepository;
  let customerRepository: PostgresqlFiscalCustomerProfileRepository;
  let itemRepository: PostgresqlFiscalItemProfileRepository;
  let syncRepository: PostgresqlZohoSyncRepository;

  function newRecord(zohoInvoiceId = `it-zoho-${randomUUID()}`) {
    testInvoiceIds.push(zohoInvoiceId);

    return createFiscalizationRecord({
      id: `it-record-${randomUUID()}`,
      zohoInvoiceId,
    });
  }

  beforeAll(async () => {
    const connectionString = process.env["ZOHO_FISCALIZATION_TEST_DATABASE_URL"];

    if (!connectionString) {
      throw new Error(
        "ZOHO_FISCALIZATION_TEST_DATABASE_URL is required to run PostgreSQL integration tests.",
      );
    }

    const parsedUrl = new URL(connectionString);

    // Guard against accidentally running these tests against another database.
    if (parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
      throw new Error("Integration tests are restricted to the local PostgreSQL database.");
    }

    if (parsedUrl.port !== "5438" || parsedUrl.pathname !== "/zoho_amarco_test") {
      throw new Error("Integration tests require zoho_amarco_test on localhost port 5438.");
    }

    prisma = createPostgresqlClient(connectionString);
    repository = new PostgresqlFiscalizationRepository(prisma);
    customerRepository = new PostgresqlFiscalCustomerProfileRepository(prisma);
    itemRepository = new PostgresqlFiscalItemProfileRepository(prisma);
    syncRepository = new PostgresqlZohoSyncRepository(prisma);

    await prisma.$connect();
  });

  afterEach(async () => {
    // Delete only records created by this test suite, never the whole table.
    if (testInvoiceIds.length > 0) {
      await prisma.fiscalizationRecord.deleteMany({
        where: { zohoInvoiceId: { in: [...testInvoiceIds] } },
      });
      testInvoiceIds.length = 0;
    }

    if (testCustomerIds.length > 0) {
      await prisma.fiscalCustomerProfile.deleteMany({
        where: { zohoCustomerId: { in: [...testCustomerIds] } },
      });
      testCustomerIds.length = 0;
    }

    if (testItemIds.length > 0) {
      await prisma.fiscalItemProfile.deleteMany({
        where: { zohoItemId: { in: [...testItemIds] } },
      });
      testItemIds.length = 0;
    }

    if (syncRunIds.length > 0) {
      await prisma.zohoSyncRun.deleteMany({ where: { id: { in: [...syncRunIds] } } });
      syncRunIds.length = 0;
    }

    if (syncOrganizationIds.length > 0) {
      await prisma.zohoSyncLock.deleteMany({
        where: { organizationId: { in: [...syncOrganizationIds] } },
      });
      syncOrganizationIds.length = 0;
    }
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

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  it("enforces one fiscalization record per Zoho invoice", async () => {
    const original = newRecord();
    const duplicate = newRecord(original.zohoInvoiceId);

    await repository.create(original);

    await expect(repository.create(duplicate)).rejects.toBeInstanceOf(DuplicateZohoInvoiceError);

    const stored = await repository.findById(original.id);

    expect(stored?.zohoInvoiceId).toBe(original.zohoInvoiceId);
    expect(stored?.status).toBe("Pending");
  });

  it("persists and validates the immutable invoice snapshot", async () => {
    const invoiceId = `it-snapshot-${randomUUID()}`;
    testInvoiceIds.push(invoiceId);
    const invoice: FiscalInvoiceCandidate = {
      zohoInvoiceId: invoiceId,
      invoiceNumber: "SNAPSHOT-1",
      customerId: "customer-snapshot",
      customerName: "Snapshot customer",
      currencyCode: "KES",
      lines: [
        {
          sourceLineId: "line-1",
          itemId: "item-snapshot",
          description: "Snapshot item",
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
    };
    const snapshot = await makeFiscalizationSnapshot(invoice);
    const record = createFiscalizationRecord({
      id: `it-record-${randomUUID()}`,
      zohoInvoiceId: invoiceId,
      snapshot,
    });

    await repository.create(record);
    const stored = await repository.findById(record.id);

    expect(stored?.snapshot).toEqual(snapshot);
    expect(stored?.snapshotVersion).toBe(snapshot.schemaVersion);
  });

  it("creates, reads, and updates fiscal customer and item profiles", async () => {
    const customerId = `it-customer-${randomUUID()}`;
    const itemId = `it-item-${randomUUID()}`;
    testCustomerIds.push(customerId);
    testItemIds.push(itemId);

    await customerRepository.create({
      zohoCustomerId: customerId,
      companyName: "Test Company",
      clientPin: "P051234567X",
      headquarters: "Nairobi",
      address: "Test Road",
      postalCodeAndCity: "00100 Nairobi",
      exemptionNumber: null,
    });
    await itemRepository.create({
      zohoItemId: itemId,
      measureUnit: "EA",
      hsCode: "1234.56.78",
      hsName: "Test item",
      vatClass: "A",
      vatGroupRate: "16",
    });

    expect(await customerRepository.findByZohoCustomerId(customerId)).toMatchObject({
      zohoCustomerId: customerId,
      companyName: "Test Company",
    });
    expect(await itemRepository.findByZohoItemId(itemId)).toMatchObject({
      zohoItemId: itemId,
      measureUnit: "EA",
    });

    expect(
      await customerRepository.update(customerId, {
        companyName: "Updated Company",
        clientPin: "P051234567X",
        headquarters: "Mombasa",
        address: "New Road",
        postalCodeAndCity: "80100 Mombasa",
        exemptionNumber: null,
      }),
    ).toMatchObject({ companyName: "Updated Company" });
    expect(
      await itemRepository.update(itemId, {
        measureUnit: "KG",
        hsCode: "1234.56.78",
        hsName: "Updated item",
        vatClass: "A",
        vatGroupRate: "16",
      }),
    ).toMatchObject({ measureUnit: "KG" });
  });

  it("allows only one concurrent worker to claim a Pending record", async () => {
    const record = newRecord();
    await repository.create(record);

    const results = await Promise.all([
      repository.claimPending(record.id),
      repository.claimPending(record.id),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);

    const stored = await repository.findById(record.id);
    expect(stored?.status).toBe("InProgress");
  });

  it("persists a confirmed receipt and its Succeeded status", async () => {
    const record = newRecord();
    await repository.create(record);

    const claimed = await repository.claimPending(record.id);
    expect(claimed).not.toBeNull();

    if (!claimed) {
      throw new Error("Expected the Pending record to be claimed.");
    }

    const issuedAt = new Date("2026-10-24T08:30:00.000Z");

    const completed = completeFiscalization(claimed, {
      receiptNumber: "INTEGRATION-TEST-RECEIPT",
      issuedAt,
    });

    expect(await repository.saveOutcome(completed)).toBe(true);

    const stored = await repository.findById(record.id);

    expect(stored?.status).toBe("Succeeded");
    expect(stored?.receipt).toEqual({
      receiptNumber: "INTEGRATION-TEST-RECEIPT",
      issuedAt,
    });
  });

  it("recovers stale requests without changing fresh or succeeded records", async () => {
    const staleRecord = newRecord();
    const freshRecord = newRecord();
    const succeededRecord = newRecord();

    await repository.create(staleRecord);
    await repository.create(freshRecord);
    await repository.create(succeededRecord);

    const staleClaim = await repository.claimPending(staleRecord.id);
    const freshClaim = await repository.claimPending(freshRecord.id);
    const succeededClaim = await repository.claimPending(succeededRecord.id);

    expect(staleClaim).not.toBeNull();
    expect(freshClaim).not.toBeNull();
    expect(succeededClaim).not.toBeNull();

    if (!staleClaim || !freshClaim || !succeededClaim) {
      throw new Error("Expected all three records to be claimed.");
    }

    const issuedAt = new Date("2026-10-24T08:30:00.000Z");

    const succeeded = completeFiscalization(succeededClaim, {
      receiptNumber: "RECOVERY-TEST-RECEIPT",
      issuedAt,
    });

    expect(await repository.saveOutcome(succeeded)).toBe(true);

    // Make only the first InProgress record stale.
    const staleBefore = new Date(Date.now() - 30_000);
    const staleUpdatedAt = new Date(staleBefore.getTime() - 1_000);

    await prisma.fiscalizationRecord.update({
      where: { id: staleRecord.id },
      data: { updatedAt: staleUpdatedAt },
    });

    const reason = "Integration test: stale processing recovery.";

    const recoveredCount = await repository.markStaleInProgressOutcomeUnknown(staleBefore, reason);

    expect(recoveredCount).toBe(1);

    const storedStale = await repository.findById(staleRecord.id);
    const storedFresh = await repository.findById(freshRecord.id);
    const storedSucceeded = await repository.findById(succeededRecord.id);

    expect(storedStale?.status).toBe("OutcomeUnknown");
    expect(storedStale?.outcomeUnknownReason).toBe(reason);
    expect(storedStale?.receipt).toBeNull();

    expect(storedFresh?.status).toBe("InProgress");

    expect(storedSucceeded?.status).toBe("Succeeded");
    expect(storedSucceeded?.receipt).toEqual({
      receiptNumber: "RECOVERY-TEST-RECEIPT",
      issuedAt,
    });

    // Recovery is idempotent: the same record is not recovered twice.
    expect(await repository.markStaleInProgressOutcomeUnknown(staleBefore, reason)).toBe(0);
  });

  it("does not let a late outcome overwrite a recovered request", async () => {
    const record = newRecord();
    await repository.create(record);

    const claimed = await repository.claimPending(record.id);
    expect(claimed).not.toBeNull();

    if (!claimed) {
      throw new Error("Expected the Pending record to be claimed.");
    }

    const staleBefore = new Date(Date.now() - 30_000);

    await prisma.fiscalizationRecord.update({
      where: { id: record.id },
      data: {
        updatedAt: new Date(staleBefore.getTime() - 1_000),
      },
    });

    expect(
      await repository.markStaleInProgressOutcomeUnknown(
        staleBefore,
        "Integration test: device outcome requires reconciliation.",
      ),
    ).toBe(1);

    // Simulate the original worker receiving a late success response.
    const lateSuccess = completeFiscalization(claimed, {
      receiptNumber: "LATE-TEST-RECEIPT",
      issuedAt: new Date("2026-10-24T08:30:00.000Z"),
    });

    expect(await repository.saveOutcome(lateSuccess)).toBe(false);

    const stored = await repository.findById(record.id);

    expect(stored?.status).toBe("OutcomeUnknown");
    expect(stored?.receipt).toBeNull();
    expect(stored?.outcomeUnknownReason).toBe(
      "Integration test: device outcome requires reconciliation.",
    );
  });
});
