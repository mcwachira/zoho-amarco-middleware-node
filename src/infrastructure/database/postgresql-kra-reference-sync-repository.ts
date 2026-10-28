import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import type {
  KraReferenceSyncState,
  KraReferenceSyncRepository,
  KraReferenceSyncScope,
} from "../../application/etims/kra-reference-sync-repository.js";

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export class PostgresqlKraReferenceSyncRepository implements KraReferenceSyncRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async find(scope: KraReferenceSyncScope): Promise<KraReferenceSyncState | null> {
    return (await this.prisma.kraReferenceSyncState.findUnique({
      where: { provider_adapterIdentity_taxpayerTin_branchId_category: scope },
    })) as KraReferenceSyncState | null;
  }

  async tryAcquire(
    scope: KraReferenceSyncScope,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.kraReferenceSyncState.create({
        data: {
          id: randomUUID(),
          ...scope,
          leaseToken,
          leaseExpiresAt,
          updatedAt: now,
        },
      });
      return true;
    } catch (error: unknown) {
      if (!isUniqueConflict(error)) throw error;
    }

    const updated = await this.prisma.kraReferenceSyncState.updateMany({
      where: {
        ...scope,
        OR: [{ leaseToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
      },
      data: { leaseToken, leaseExpiresAt, updatedAt: now },
    });
    return updated.count === 1;
  }

  async renew(
    scope: KraReferenceSyncScope,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const updated = await this.prisma.kraReferenceSyncState.updateMany({
      where: {
        ...scope,
        leaseToken,
        leaseExpiresAt: { gt: now },
      },
      data: { leaseExpiresAt, updatedAt: now },
    });
    return updated.count === 1;
  }

  async release(scope: KraReferenceSyncScope, leaseToken: string): Promise<void> {
    await this.prisma.kraReferenceSyncState.updateMany({
      where: { ...scope, leaseToken },
      data: { leaseToken: null, leaseExpiresAt: null },
    });
  }

  async recordAttempt(
    scope: KraReferenceSyncScope,
    leaseToken: string,
    now: Date,
    attempt: {
      readonly status:
        "attempted" | "provider_rejected" | "malformed_response" | "provider_acceptance_required";
      readonly attemptedAt: Date;
      readonly errorCategory?: string;
      readonly correlationId: string;
    },
  ): Promise<boolean> {
    const updated = await this.prisma.kraReferenceSyncState.updateMany({
      where: { ...scope, leaseToken, leaseExpiresAt: { gt: now } },
      data: {
        lastAttemptAt: attempt.attemptedAt,
        attemptStatus: attempt.status,
        lastErrorCategory: attempt.errorCategory ?? null,
        correlationId: attempt.correlationId,
        updatedAt: now,
      },
    });
    return updated.count === 1;
  }
}
