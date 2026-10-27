import { describe, expect, it, vi } from "vitest";
import type { EtimsReportingRepository } from "../../src/application/fiscalization/etims-reporting-repository.js";
import type { EtimsReportingOperation } from "../../src/domain/fiscalization/etims-reporting.js";
import type { PrismaClient as PostgresqlPrismaClient } from "../../src/generated/prisma/postgresql/client.js";
import type { PrismaClient as SqlServerPrismaClient } from "../../src/generated/prisma/sqlserver/client.js";
import { PostgresqlEtimsReportingRepository } from "../../src/infrastructure/database/postgresql-etims-reporting-repository.js";
import { SqlServerEtimsReportingRepository } from "../../src/infrastructure/database/sqlserver-etims-reporting-repository.js";

const now = new Date("2026-10-27T07:00:00.000Z");
const inProgressRow = {
  id: "operation-1",
  fiscalizationRequestId: "fiscalization-1",
  zohoInvoiceId: "zoho-invoice-1",
  adapterType: "vscu",
  adapterConfigurationId: null,
  correlationId: "correlation-1",
  status: "in_progress",
  payloadHash: "a".repeat(64),
  attemptNumber: 1,
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
  [
    "SQL Server",
    (client) => new SqlServerEtimsReportingRepository(client as unknown as SqlServerPrismaClient),
  ],
];

describe.each(repositories)("%s eTIMS reporting repository", (_provider, createRepository) => {
  it("uses a compare-and-set claim and creates only one concurrent attempt", async () => {
    const { client, transaction } = createMockClient();
    transaction.etimsReportingOperation.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const repository = createRepository(client);

    const first = await repository.claimPending("operation-1", now);
    const second = await repository.claimPending("operation-1", now);

    expect(first?.status).toBe("in_progress");
    expect(second).toBeNull();
    expect(transaction.etimsReportingOperation.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "operation-1", status: "pending" },
      data: { status: "in_progress", attemptNumber: { increment: 1 }, updatedAt: now },
    });
    expect(transaction.etimsReportingAttempt.create).toHaveBeenCalledOnce();
    expect(client.$transaction).toHaveBeenCalledTimes(2);
  });

  it("rejects terminal state overwrites before issuing a database update", async () => {
    const { client, transaction } = createMockClient();
    const repository = createRepository(client);
    const accepted: EtimsReportingOperation = {
      ...inProgressRow,
      status: "pending",
      attemptNumber: 1,
    };

    await expect(repository.transition("operation-1", "accepted", accepted)).rejects.toThrow(
      "Invalid eTIMS reporting transition",
    );
    expect(transaction.etimsReportingOperation.updateMany).not.toHaveBeenCalled();
  });
});
