import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/postgresql/client.js";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import type { FiscalizationRecordRow } from "../../src/infrastructure/database/fiscalization-record-mapper.js";
import { PostgresqlFiscalizationRepository } from "../../src/infrastructure/database/postgresql-fiscalization-repository.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";

const now = new Date("2026-10-23T07:00:00.000Z");

function makeRow(overrides: Partial<FiscalizationRecordRow> = {}): FiscalizationRecordRow {
  return {
    id: "fiscalization-001",
    zohoInvoiceId: "zoho-invoice-001",
    status: "Pending",
    receiptNumber: null,
    issuedAt: null,
    failureCode: null,
    failureMessage: null,
    outcomeUnknownReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createHarness() {
  const prismaMock = {
    fiscalizationRecord: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };

  const prisma = prismaMock as unknown as PrismaClient;
  const repository = new PostgresqlFiscalizationRepository(prisma);

  return { prismaMock, repository };
}

describe("PostgresqlFiscalizationRepository", () => {
  let prismaMock: ReturnType<typeof createHarness>["prismaMock"];
  let repository: PostgresqlFiscalizationRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ prismaMock, repository } = createHarness());
  });

  it("returns a mapped record when the ID exists", async () => {
    prismaMock.fiscalizationRecord.findUnique.mockResolvedValue(makeRow());

    const result = await repository.findById("fiscalization-001");

    expect(result?.id).toBe("fiscalization-001");
    expect(result?.status).toBe("Pending");
    expect(prismaMock.fiscalizationRecord.findUnique).toHaveBeenCalledWith({
      where: { id: "fiscalization-001" },
    });
  });

  it("returns null when the ID does not exist", async () => {
    prismaMock.fiscalizationRecord.findUnique.mockResolvedValue(null);

    const result = await repository.findById("missing-record");

    expect(result).toBeNull();
  });

  it("creates a record using the database mapper", async () => {
    prismaMock.fiscalizationRecord.create.mockResolvedValue(makeRow());

    const record = createFiscalizationRecord({
      id: "fiscalization-001",
      zohoInvoiceId: "zoho-invoice-001",
    });

    await repository.create(record);

    expect(prismaMock.fiscalizationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: "fiscalization-001",
        zohoInvoiceId: "zoho-invoice-001",
        status: "Pending",
        receiptNumber: null,
      }),
    });
  });

  it("claims only a Pending record", async () => {
    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.fiscalizationRecord.findUnique.mockResolvedValue(makeRow({ status: "InProgress" }));

    const result = await repository.claimPending("fiscalization-001");

    expect(prismaMock.fiscalizationRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "fiscalization-001",
        status: "Pending",
      },
      data: {
        status: "InProgress",
        updatedAt: expect.any(Date),
      },
    });

    expect(result?.status).toBe("InProgress");
  });

  it("returns null when a Pending record cannot be claimed", async () => {
    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 0 });

    const result = await repository.claimPending("fiscalization-001");

    expect(result).toBeNull();

    // No follow-up read should happen when the claim failed.
    expect(prismaMock.fiscalizationRecord.findUnique).not.toHaveBeenCalled();
  });

  it("returns null if the record disappears after being claimed", async () => {
    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.fiscalizationRecord.findUnique.mockResolvedValue(null);

    const result = await repository.claimPending("fiscalization-001");

    expect(result).toBeNull();
  });

  it("saves an outcome only when the record is still InProgress", async () => {
    const pending = createFiscalizationRecord({
      id: "fiscalization-001",
      zohoInvoiceId: "zoho-invoice-001",
    });
    const inProgress = startFiscalization(pending);

    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 1 });

    const result = await repository.saveOutcome({
      ...inProgress,
      status: "Succeeded",
      receipt: {
        receiptNumber: "CU-000123",
        issuedAt: now,
      },
    });

    expect(prismaMock.fiscalizationRecord.updateMany).toHaveBeenCalledWith({
      where: {
        id: "fiscalization-001",
        status: "InProgress",
      },
      data: expect.objectContaining({
        status: "Succeeded",
        receiptNumber: "CU-000123",
        issuedAt: now,
      }),
    });

    expect(result).toBe(true);
  });

  it("returns false when the outcome update affects no record", async () => {
    const pending = createFiscalizationRecord({
      id: "fiscalization-001",
      zohoInvoiceId: "zoho-invoice-001",
    });
    const inProgress = startFiscalization(pending);

    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 0 });

    const result = await repository.saveOutcome({
      ...inProgress,
      status: "OutcomeUnknown",
      outcomeUnknownReason: "The device result could not be confirmed.",
    });

    expect(result).toBe(false);
  });

  it("translates a Zoho invoice unique constraint violation", async () => {
    const record = createFiscalizationRecord({
      id: "fiscalization-001",
      zohoInvoiceId: "zoho-invoice-001",
    });

    prismaMock.fiscalizationRecord.create.mockRejectedValue({
      code: "P2002",
      meta: {
        target: ["zohoInvoiceId"],
      },
    });

    await expect(repository.create(record)).rejects.toBeInstanceOf(DuplicateZohoInvoiceError);

    expect(prismaMock.fiscalizationRecord.create).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated unique constraint errors", async () => {
    const record = createFiscalizationRecord({
      id: "fiscalization-001",
      zohoInvoiceId: "zoho-invoice-001",
    });

    const databaseError = {
      code: "P2002",
      meta: {
        target: ["id"],
      },
    };

    prismaMock.fiscalizationRecord.create.mockRejectedValue(databaseError);

    await expect(repository.create(record)).rejects.toBe(databaseError);
  });

  it("marks stale InProgress records as OutcomeUnknown", async () => {
    const staleBefore = new Date("2026-10-23T08:00:00.000Z");
    const reason = "The request was abandoned before its device outcome was saved.";

    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 2 });

    const result = await repository.markStaleInProgressOutcomeUnknown(staleBefore, reason);

    expect(prismaMock.fiscalizationRecord.updateMany).toHaveBeenCalledWith({
      where: {
        status: "InProgress",
        updatedAt: {
          lt: staleBefore,
        },
      },
      data: {
        status: "OutcomeUnknown",
        receiptNumber: null,
        issuedAt: null,
        failureCode: null,
        failureMessage: null,
        outcomeUnknownReason: reason,
        updatedAt: expect.any(Date),
      },
    });

    expect(result).toBe(2);
  });

  it("returns zero when no stale InProgress records are found", async () => {
    prismaMock.fiscalizationRecord.updateMany.mockResolvedValue({ count: 0 });

    const result = await repository.markStaleInProgressOutcomeUnknown(
      new Date("2026-10-23T08:00:00.000Z"),
      "Recovery after an interrupted request.",
    );

    expect(result).toBe(0);
  });

  it("rejects a blank recovery reason without updating the database", async () => {
    await expect(
      repository.markStaleInProgressOutcomeUnknown(new Date("2026-10-23T08:00:00.000Z"), "   "),
    ).rejects.toThrow("Recovery reason must not be empty.");

    expect(prismaMock.fiscalizationRecord.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a recovery reason longer than 2000 characters", async () => {
    await expect(
      repository.markStaleInProgressOutcomeUnknown(
        new Date("2026-10-23T08:00:00.000Z"),
        "x".repeat(2001),
      ),
    ).rejects.toThrow("Recovery reason must not exceed 2000 characters.");

    expect(prismaMock.fiscalizationRecord.updateMany).not.toHaveBeenCalled();
  });
});
