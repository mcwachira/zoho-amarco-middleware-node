import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/sqlserver/client.js";
import { SqlServerZohoOAuthAttemptRepository } from "../../src/infrastructure/database/sqlserver-zoho-oauth-attempt-repository.js";

const now = new Date("2026-10-24T12:00:00.000Z");

const newAttempt = {
  stateHash: "a".repeat(64),
  encryptedCodeVerifier: "encrypted-verifier-payload",
  expiresAt: new Date("2026-10-24T12:05:00.000Z"),
};

function createHarness() {
  const transactionMock = {
    zohoOAuthAttempt: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };

  const prismaMock = {
    zohoOAuthAttempt: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (callback: (transaction: unknown) => unknown) =>
      callback(transactionMock),
    ),
  };

  const prisma = prismaMock as unknown as PrismaClient;
  const repository = new SqlServerZohoOAuthAttemptRepository(prisma);

  return { prismaMock, transactionMock, repository };
}

describe("SqlServerZohoOAuthAttemptRepository", () => {
  let prismaMock: ReturnType<typeof createHarness>["prismaMock"];
  let transactionMock: ReturnType<typeof createHarness>["transactionMock"];
  let repository: SqlServerZohoOAuthAttemptRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ prismaMock, transactionMock, repository } = createHarness());
  });

  it("creates an OAuth attempt with the supplied values", async () => {
    prismaMock.zohoOAuthAttempt.create.mockResolvedValue({
      id: "attempt-001",
      ...newAttempt,
      consumedAt: null,
      createdAt: now,
    });

    await repository.create(newAttempt);

    expect(prismaMock.zohoOAuthAttempt.create).toHaveBeenCalledWith({
      data: newAttempt,
    });
  });

  it("returns the encrypted verifier after successfully claiming an attempt", async () => {
    transactionMock.zohoOAuthAttempt.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMock.zohoOAuthAttempt.findUnique.mockResolvedValue({
      encryptedCodeVerifier: newAttempt.encryptedCodeVerifier,
    });

    const result = await repository.consume(newAttempt.stateHash, now);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);

    expect(transactionMock.zohoOAuthAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        stateHash: newAttempt.stateHash,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        consumedAt: now,
      },
    });

    expect(transactionMock.zohoOAuthAttempt.findUnique).toHaveBeenCalledWith({
      where: { stateHash: newAttempt.stateHash },
      select: { encryptedCodeVerifier: true },
    });

    expect(result).toEqual({
      encryptedCodeVerifier: newAttempt.encryptedCodeVerifier,
    });
  });

  it("returns null when an attempt cannot be claimed", async () => {
    transactionMock.zohoOAuthAttempt.updateMany.mockResolvedValue({
      count: 0,
    });

    const result = await repository.consume(newAttempt.stateHash, now);

    expect(result).toBeNull();
    expect(transactionMock.zohoOAuthAttempt.findUnique).not.toHaveBeenCalled();
  });

  it("does not return a verifier if retrieval fails after a successful claim", async () => {
    transactionMock.zohoOAuthAttempt.updateMany.mockResolvedValue({
      count: 1,
    });
    transactionMock.zohoOAuthAttempt.findUnique.mockResolvedValue(null);

    await expect(repository.consume(newAttempt.stateHash, now)).rejects.toThrow(
      "Claimed Zoho OAuth attempt could not be retrieved",
    );
  });

  it("propagates errors from the database transaction", async () => {
    const databaseError = new Error("Database transaction failed");

    prismaMock.$transaction.mockRejectedValue(databaseError);

    await expect(repository.consume(newAttempt.stateHash, now)).rejects.toBe(databaseError);
  });

  it("deletes expired attempts and returns the number deleted", async () => {
    prismaMock.zohoOAuthAttempt.deleteMany.mockResolvedValue({
      count: 3,
    });

    const result = await repository.deleteExpired(now);

    expect(prismaMock.zohoOAuthAttempt.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lte: now,
        },
      },
    });

    expect(result).toBe(3);
  });

  it("returns zero when no expired attempts exist", async () => {
    prismaMock.zohoOAuthAttempt.deleteMany.mockResolvedValue({
      count: 0,
    });

    const result = await repository.deleteExpired(now);

    expect(result).toBe(0);
  });

  it("propagates errors when deleting expired attempts fails", async () => {
    const databaseError = new Error("Database cleanup failed");

    prismaMock.zohoOAuthAttempt.deleteMany.mockRejectedValue(databaseError);

    await expect(repository.deleteExpired(now)).rejects.toBe(databaseError);
  });
});
