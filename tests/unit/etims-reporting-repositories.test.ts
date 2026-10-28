import { describe, expect, it, vi } from "vitest";
import type { EtimsReportingRepository } from "../../src/application/fiscalization/etims-reporting-repository.js";
import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
} from "../../src/domain/fiscalization/etims-reporting.js";
import type { PrismaClient as PostgresqlPrismaClient } from "../../src/generated/prisma/postgresql/client.js";
import { PostgresqlEtimsReportingRepository } from "../../src/infrastructure/database/postgresql-etims-reporting-repository.js";

const now = new Date("2026-10-27T07:00:00.000Z");
const inProgressRow = {
  id: "operation-1",
  fiscalizationRequestId: "fiscalization-1",
  zohoInvoiceId: "zoho-invoice-1",
  adapterType: "vscu" as const,
  adapterConfigurationId: null,
  correlationId: "correlation-1",
  status: "in_progress",
  payloadHash: "a".repeat(64),
  attemptNumber: 1,
  reconciliationAttemptNumber: 0,
  providerReference: null,
  providerMetadataJson: null,
  errorCategory: null,
  errorMessage: null,
  reconciliationRequired: false,
  createdAt: now,
  updatedAt: now,
};

function createMockClient() {
  const transaction = {
    etimsReportingOperation: {
      updateMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(inProgressRow),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    etimsReportingAttempt: {
      create: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    etimsSubmissionPayload: {
      create: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
  const client = {
    ...transaction,
    $transaction: vi.fn(async <T>(callback: (tx: typeof transaction) => Promise<T>): Promise<T> =>
      callback(transaction),
    ),
  };
  return { client, transaction };
}

const repositories: readonly [
  string,
  (client: ReturnType<typeof createMockClient>["client"]) => EtimsReportingRepository,
][] = [
  [
    "PostgreSQL",
    (client) => new PostgresqlEtimsReportingRepository(client as unknown as PostgresqlPrismaClient),
  ],
];

describe.each(repositories)("%s eTIMS reporting repository", (_provider, createRepository) => {
  it("lists only unresolved reconciliation candidates in deterministic bounded order", async () => {
    const { client } = createMockClient();
    client.etimsReportingOperation.findMany.mockResolvedValue([
      { ...inProgressRow, status: "reconciliation_required", reconciliationRequired: true },
    ]);
    client.etimsReportingAttempt.findMany.mockResolvedValue([]);
    const repository = createRepository(client);

    const candidates = await repository.findReconciliationCandidates(10);

    expect(client.etimsReportingOperation.findMany).toHaveBeenCalledWith({
      where: {
        status: { in: ["outcome_unknown", "reconciliation_required"] },
        reconciliationRequired: true,
        adapterType: { not: null },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: 10,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.operation.status).toBe("reconciliation_required");
  });

  it("rejects unbounded reconciliation candidate queries", async () => {
    const { client } = createMockClient();
    const repository = createRepository(client);

    await expect(repository.findReconciliationCandidates(101)).rejects.toThrow(
      "must be between 1 and 100",
    );
    expect(client.etimsReportingOperation.findMany).not.toHaveBeenCalled();
  });

  it("uses a compare-and-set claim and creates only one concurrent attempt", async () => {
    const { client, transaction } = createMockClient();
    transaction.etimsReportingOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    transaction.etimsSubmissionPayload.create.mockResolvedValue({});
    const repository = createRepository(client);

    const claim = {
      operationId: "operation-1",
      now,
      payload: {
        operationId: "operation-1",
        fiscalizationRequestId: "fiscalization-1",
        payloadVersion: 1,
        protectionVersion: 2,
        encryptionKeyId: "test-v1",
        payloadHash: "a".repeat(64),
        submissionAttemptType: "submission" as const,
        submissionAttemptNumber: 1,
        encryptedPayload: "ciphertext",
        createdAt: now,
      },
    };
    transaction.etimsReportingOperation.findUnique.mockResolvedValue({
      ...inProgressRow,
      status: "in_progress",
      attemptNumber: 1,
    });
    const first = await repository.claimPending(claim);
    const second = await repository.claimPending(claim);

    expect(first?.status).toBe("in_progress");
    expect(second).toBeNull();
    expect(transaction.etimsReportingOperation.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "operation-1", status: "pending" },
      data: { status: "in_progress", attemptNumber: { increment: 1 }, updatedAt: now },
    });
    expect(transaction.etimsReportingAttempt.create).toHaveBeenCalledOnce();
    expect(transaction.etimsSubmissionPayload.create).toHaveBeenCalledOnce();
    expect(client.$transaction).toHaveBeenCalledTimes(2);
  });

  it("persists a reconciliation result and its typed attempt atomically", async () => {
    const { client, transaction } = createMockClient();
    transaction.etimsReportingOperation.updateMany.mockResolvedValue({ count: 1 });
    transaction.etimsReportingAttempt.updateMany.mockResolvedValue({ count: 1 });
    const repository = createRepository(client);
    const operation: EtimsReportingOperation = {
      ...inProgressRow,
      status: "accepted",
      reconciliationAttemptNumber: 1,
      providerReference: "MOCK-RECONCILED",
    };
    const attempt: EtimsReportingAttempt = {
      id: "attempt-reconcile-1",
      operationId: operation.id,
      attemptType: "reconciliation",
      attemptNumber: 1,
      startedAt: now,
      completedAt: now,
      outcome: "accepted",
      providerReference: "MOCK-RECONCILED",
      errorCategory: null,
      errorMessage: null,
    };

    expect(await repository.completeAttempt(operation, attempt)).toBe(true);
    expect(transaction.etimsReportingOperation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "reconciling", reconciliationAttemptNumber: 1 }),
      }),
    );
    expect(transaction.etimsReportingAttempt.updateMany).toHaveBeenCalledWith({
      where: { operationId: operation.id, attemptType: "reconciliation", attemptNumber: 1 },
      data: expect.objectContaining({ outcome: "accepted", providerReference: "MOCK-RECONCILED" }),
    });
  });

  it("uses a compare-and-set claim for reconciliation", async () => {
    const { client, transaction } = createMockClient();
    transaction.etimsReportingOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    transaction.etimsReportingOperation.findUnique.mockResolvedValueOnce({
      ...inProgressRow,
      status: "reconciling",
      reconciliationAttemptNumber: 1,
    });
    const repository = createRepository(client);

    const first = await repository.claimReconciliation("operation-1", "outcome_unknown", now);
    const second = await repository.claimReconciliation("operation-1", "outcome_unknown", now);

    expect(first?.status).toBe("reconciling");
    expect(second).toBeNull();
    expect(transaction.etimsReportingOperation.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "operation-1", status: "outcome_unknown" },
      data: {
        status: "reconciling",
        reconciliationAttemptNumber: { increment: 1 },
        updatedAt: now,
      },
    });
    expect(transaction.etimsReportingOperation.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "operation-1", status: "outcome_unknown" },
      data: {
        status: "reconciling",
        reconciliationAttemptNumber: { increment: 1 },
        updatedAt: now,
      },
    });
    expect(transaction.etimsReportingAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationId: "operation-1",
        attemptType: "reconciliation",
        attemptNumber: 1,
        startedAt: now,
      }),
    });
  });

  it("rejects terminal state overwrites before issuing a database update", async () => {
    const { client, transaction } = createMockClient();
    const repository = createRepository(client);
    const accepted: EtimsReportingOperation = {
      ...inProgressRow,
      status: "pending",
      attemptNumber: 1,
      reconciliationAttemptNumber: 0,
    };

    await expect(repository.transition("operation-1", "accepted", accepted)).rejects.toThrow(
      "Invalid eTIMS reporting transition",
    );
    expect(transaction.etimsReportingOperation.updateMany).not.toHaveBeenCalled();
  });
});
