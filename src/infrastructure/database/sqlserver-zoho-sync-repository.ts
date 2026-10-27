import type {
  ZohoSyncRepository,
  ZohoSyncRun,
} from "../../application/zoho/zoho-sync-repository.js";
import type { PrismaClient } from "../../generated/prisma/sqlserver/client.js";

function isUniqueConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function mapRun(row: {
  id: string;
  organizationId: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  discovered: number;
  imported: number;
  duplicatesSkipped: number;
  rejected: number;
  failed: number;
  pagesRetrieved: number;
  paginationComplete: boolean;
  errorCode: string | null;
}): ZohoSyncRun {
  if (!["Running", "Succeeded", "Partial", "Failed"].includes(row.status)) {
    throw new Error("Stored Zoho synchronization run has an invalid status.");
  }
  return { ...row, status: row.status as ZohoSyncRun["status"] };
}

export class SqlServerZohoSyncRepository implements ZohoSyncRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async tryAcquire(
    organizationId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    try {
      await this.prisma.zohoSyncLock.create({
        data: { organizationId, leaseToken, leaseExpiresAt, updatedAt: now },
      });
      return true;
    } catch (error: unknown) {
      if (!isUniqueConflict(error)) throw error;
    }

    const updated = await this.prisma.zohoSyncLock.updateMany({
      where: { organizationId, leaseExpiresAt: { lte: now } },
      data: { leaseToken, leaseExpiresAt, updatedAt: now },
    });
    return updated.count === 1;
  }

  async renew(
    organizationId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const updated = await this.prisma.zohoSyncLock.updateMany({
      where: { organizationId, leaseToken, leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt, updatedAt: now },
    });
    return updated.count === 1;
  }

  async release(organizationId: string, leaseToken: string, now: Date): Promise<void> {
    await this.prisma.zohoSyncLock.updateMany({
      where: { organizationId, leaseToken },
      data: { leaseExpiresAt: now, updatedAt: now },
    });
  }

  async createRun(run: Pick<ZohoSyncRun, "id" | "organizationId" | "startedAt">): Promise<void> {
    await this.prisma.zohoSyncRun.create({ data: run });
  }

  async completeRun(
    id: string,
    result: Omit<ZohoSyncRun, "id" | "organizationId" | "startedAt">,
  ): Promise<void> {
    const updated = await this.prisma.zohoSyncRun.updateMany({
      where: { id, status: "Running" },
      data: result,
    });
    if (updated.count !== 1) {
      throw new Error("Zoho synchronization run could not be completed from its current state.");
    }
  }

  async recoverAbandonedRuns(
    organizationId: string,
    exceptRunId: string,
    completedAt: Date,
  ): Promise<number> {
    const recovered = await this.prisma.zohoSyncRun.updateMany({
      where: { organizationId, status: "Running", id: { not: exceptRunId } },
      data: {
        status: "Failed",
        completedAt,
        errorCode: "STALE_RUN_RECOVERED",
      },
    });
    return recovered.count;
  }

  async getLatest(organizationId: string): Promise<{
    readonly lock: {
      readonly organizationId: string;
      readonly leaseToken: string;
      readonly leaseExpiresAt: Date;
    } | null;
    readonly run: ZohoSyncRun | null;
    readonly lastSuccessfulRun: ZohoSyncRun | null;
  }> {
    const [lock, run, lastSuccessfulRun] = await Promise.all([
      this.prisma.zohoSyncLock.findUnique({ where: { organizationId } }),
      this.prisma.zohoSyncRun.findFirst({
        where: { organizationId },
        orderBy: { startedAt: "desc" },
      }),
      this.prisma.zohoSyncRun.findFirst({
        where: { organizationId, status: "Succeeded", paginationComplete: true },
        orderBy: { completedAt: "desc" },
      }),
    ]);
    return {
      lock,
      run: run === null ? null : mapRun(run),
      lastSuccessfulRun: lastSuccessfulRun === null ? null : mapRun(lastSuccessfulRun),
    };
  }
}
