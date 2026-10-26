import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { completeFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlFiscalizationRepository } from "../../src/infrastructure/database/postgresql-fiscalization-repository.js";

const integrationEnabled = process.env["RUN_POSTGRES_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("PostgreSQL fiscalization repository (integrations)", () => {
  const testInvoiceIds: string[] = [];

  let prisma: ReturnType<typeof createPostgresqlClient>;
  let repository: PostgresqlFiscalizationRepository;

  function newRecord(zohoInvoiceId = `it-zoho-${randomUUID()}`) {
    testInvoiceIds.push(zohoInvoiceId);

    return createFiscalizationRecord({
      id: `it-record-${randomUUID()}`,
      zohoInvoiceId,
    });
  }

  beforeAll(async () => {
    const connectionString = process.env["DATABASE_URL"];

    if (!connectionString) {
      throw new Error("DATABASE_URL is required to run PostgreSQL integrations tests.");
    }

    const parsedUrl = new URL(connectionString);

    // Guard against accidentally running these tests against another database.
    if (parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
      throw new Error("Integration tests are restricted to the local PostgreSQL database.");
    }

    if (parsedUrl.port !== "5438" || parsedUrl.pathname !== "/zoho_amarco_dev") {
      throw new Error("Integration tests require zoho_amarco_dev on localhost port 5438.");
    }

    prisma = createPostgresqlClient(connectionString);
    repository = new PostgresqlFiscalizationRepository(prisma);

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
});
