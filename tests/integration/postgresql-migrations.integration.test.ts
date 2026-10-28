import "dotenv/config";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlKraReferenceSyncRepository } from "../../src/infrastructure/database/postgresql-kra-reference-sync-repository.js";

const integrationEnabled = process.env["RUN_POSTGRES_MIGRATION_INTEGRATION"] === "1";
const migrationDatabasePattern = /^zoho_amarco_migration_test(?:_[a-z0-9]+(?:_[a-z0-9]+)*)?$/;

function getMigrationTestUrl(): string {
  const rawUrl = process.env["ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL"]?.trim();
  if (!rawUrl) {
    throw new Error("ZOHO_POSTGRES_MIGRATION_TEST_DATABASE_URL must be explicitly set.");
  }
  const url = new URL(rawUrl);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    !url.username ||
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname) ||
    url.port !== "5438" ||
    !migrationDatabasePattern.test(databaseName)
  ) {
    throw new Error(
      "PostgreSQL migration tests require localhost:5438 and a dedicated zoho_amarco_migration_test database.",
    );
  }
  return rawUrl;
}

describe.skipIf(!integrationEnabled)("PostgreSQL fresh-install migrations (integration)", () => {
  let prisma: ReturnType<typeof createPostgresqlClient>;

  beforeAll(async () => {
    const databaseUrl = getMigrationTestUrl();
    const inspectionClient = createPostgresqlClient(databaseUrl);
    try {
      await inspectionClient.$connect();
      const tables = await inspectionClient.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `;
      if (tables.length > 0) {
        throw new Error(
          "PostgreSQL migration integration requires an empty dedicated test database.",
        );
      }
    } finally {
      await inspectionClient.$disconnect();
    }

    try {
      execFileSync(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        ["exec", "prisma", "migrate", "deploy", "--schema", "prisma/postgresql/schema.prisma"],
        {
          shell: process.platform === "win32",
          stdio: "ignore",
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            PRISMA_SCHEMA: "prisma/postgresql/schema.prisma",
            PRISMA_MIGRATIONS_PATH: "prisma/postgresql/migrations",
          },
        },
      );
    } catch {
      throw new Error("PostgreSQL migrations failed on the dedicated empty test database.");
    }

    prisma = createPostgresqlClient(databaseUrl);
    await prisma.$connect();
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.kraReferenceSyncState.deleteMany({
        where: { adapterIdentity: "synthetic-integration-test-only" },
      });
    }
    await prisma?.$disconnect();
  });

  it("applies the full migration chain and creates the fiscalization and eTIMS tables", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const names = new Set(tables.map(({ table_name }) => table_name));

    for (const expected of [
      "FiscalizationRecord",
      "FiscalizationAttempt",
      "FiscalCustomerProfile",
      "FiscalItemProfile",
      "EtimsReportingOperation",
      "EtimsReportingAttempt",
      "EtimsSubmissionPayload",
      "ManualReviewCase",
      "ManualReviewDecision",
      "ZohoOAuthAttempt",
      "ZohoToken",
      "ZohoSyncRun",
      "ZohoSyncLock",
      "KraReferenceSyncState",
      "ZohoFiscalizationWritebackOperation",
      "_prisma_migrations",
    ]) {
      expect(names.has(expected)).toBe(true);
    }

    const payloadColumns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'EtimsSubmissionPayload'
    `;
    const columnNames = new Set(payloadColumns.map(({ column_name }) => column_name));
    expect(columnNames.has("protectionVersion")).toBe(true);
    expect(columnNames.has("encryptionKeyId")).toBe(true);

    const tokenColumns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'ZohoToken'
    `;
    const tokenColumnNames = new Set(tokenColumns.map(({ column_name }) => column_name));
    expect(tokenColumnNames.has("refreshLeaseToken")).toBe(true);
    expect(tokenColumnNames.has("refreshLeaseExpiresAt")).toBe(true);

    const syncColumns = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'KraReferenceSyncState'
    `;
    const syncColumnNames = new Set(syncColumns.map(({ column_name }) => column_name));
    for (const expected of [
      "lastSuccessAt",
      "providerTimestamp",
      "providerCursor",
      "activeVersion",
      "leaseToken",
      "leaseExpiresAt",
    ]) {
      expect(syncColumnNames.has(expected)).toBe(true);
    }

    const syncUniqueIndexes = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'KraReferenceSyncState'
        AND indexname = 'KraReferenceSyncState_scope_key'
    `;
    expect(syncUniqueIndexes).toHaveLength(1);
  });

  it("persists scoped reference-sync state and enforces owner-checked expiring leases", async () => {
    const scope = {
      provider: "oscu" as const,
      adapterIdentity: "synthetic-integration-test-only",
      taxpayerTin: "SYNTHETIC01",
      branchId: "00",
      category: "codes" as const,
    };
    const uniqueScope = {
      provider_adapterIdentity_taxpayerTin_branchId_category: scope,
    };
    const repository = new PostgresqlKraReferenceSyncRepository(prisma);
    const now = new Date("2026-10-27T12:00:00.000Z");
    const expiresAt = new Date(now.getTime() + 60_000);

    expect(await repository.tryAcquire(scope, "lease-setup-owner", now, expiresAt)).toBe(true);
    expect(
      await repository.recordAttempt(scope, "lease-setup-owner", now, {
        status: "attempted",
        attemptedAt: now,
        correlationId: "synthetic-correlation",
      }),
    ).toBe(true);
    await prisma.kraReferenceSyncState.update({
      where: uniqueScope,
      data: {
        lastSuccessAt: new Date("2026-10-26T12:00:00.000Z"),
        providerTimestamp: "synthetic-time",
        providerCursor: "synthetic-cursor",
        activeVersion: "synthetic-snapshot",
      },
    });
    await repository.release(scope, "lease-setup-owner");

    const acquisitions = await Promise.all([
      repository.tryAcquire(scope, "lease-owner-a", now, expiresAt),
      repository.tryAcquire(scope, "lease-owner-b", now, expiresAt),
    ]);
    expect(acquisitions.filter(Boolean)).toHaveLength(1);
    const owner = acquisitions[0] ? "lease-owner-a" : "lease-owner-b";
    const otherOwner = owner === "lease-owner-a" ? "lease-owner-b" : "lease-owner-a";

    expect(await repository.renew(scope, otherOwner, now, expiresAt)).toBe(false);
    await repository.release(scope, otherOwner);
    expect((await repository.find(scope))?.leaseToken).toBe(owner);
    expect(
      await repository.renew(
        scope,
        owner,
        new Date(now.getTime() + 1_000),
        new Date(now.getTime() + 120_000),
      ),
    ).toBe(true);
    await repository.release(scope, owner);

    const expiredAt = new Date(now.getTime() + 180_000);
    expect(await repository.tryAcquire(scope, "lease-expiring-owner", now, expiresAt)).toBe(true);
    expect(
      await repository.tryAcquire(
        scope,
        "lease-recovery-owner",
        expiredAt,
        new Date(expiredAt.getTime() + 60_000),
      ),
    ).toBe(true);
    expect(await repository.renew(scope, "lease-expiring-owner", expiredAt, expiresAt)).toBe(false);

    expect(
      await repository.recordAttempt(scope, "lease-expiring-owner", expiredAt, {
        status: "malformed_response",
        attemptedAt: expiredAt,
        errorCategory: "stale_lease",
        correlationId: "synthetic-stale-worker",
      }),
    ).toBe(false);
    expect(
      await repository.recordAttempt(scope, "lease-recovery-owner", expiredAt, {
        status: "provider_acceptance_required",
        attemptedAt: expiredAt,
        errorCategory: "synthetic_failure",
        correlationId: "synthetic-correlation-after-failure",
      }),
    ).toBe(true);
    const restartedClient = createPostgresqlClient(getMigrationTestUrl());
    const restartedRepository = new PostgresqlKraReferenceSyncRepository(restartedClient);
    // A new client observes the committed state without relying on repository-local memory.
    await restartedClient.$connect();
    try {
      const recoveredState = await restartedRepository.find(scope);
      expect(recoveredState).toMatchObject({
        lastSuccessAt: new Date("2026-10-26T12:00:00.000Z"),
        providerTimestamp: "synthetic-time",
        providerCursor: "synthetic-cursor",
        activeVersion: "synthetic-snapshot",
        attemptStatus: "provider_acceptance_required",
        lastErrorCategory: "synthetic_failure",
        correlationId: "synthetic-correlation-after-failure",
        leaseToken: "lease-recovery-owner",
      });
    } finally {
      await restartedClient.$disconnect();
    }
  });
});
