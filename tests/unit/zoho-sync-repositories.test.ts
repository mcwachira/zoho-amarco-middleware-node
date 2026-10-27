import { describe, expect, it, vi } from "vitest";

import { PostgresqlZohoSyncRepository } from "../../src/infrastructure/database/postgresql-zoho-sync-repository.js";
import { SqlServerZohoSyncRepository } from "../../src/infrastructure/database/sqlserver-zoho-sync-repository.js";

const implementations = [
  ["PostgreSQL", PostgresqlZohoSyncRepository],
  ["SQL Server", SqlServerZohoSyncRepository],
] as const;

describe.each(implementations)("%s synchronization repository", (_provider, Repository) => {
  function createRepositoryMocks(create = vi.fn(), updateMany = vi.fn()) {
    const lockDelegate = {
      create,
      updateMany,
      findUnique: vi.fn().mockResolvedValue(null),
    };
    const runDelegate = {
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    };
    const client = {
      zohoSyncLock: lockDelegate,
      zohoSyncRun: runDelegate,
    };
    const repository = new Repository(client as never);
    return { repository, lockDelegate, runDelegate };
  }

  it("uses a unique row plus an expiry compare-and-set for lease acquisition", async () => {
    const create = vi.fn().mockRejectedValue({ code: "P2002" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { repository, lockDelegate } = createRepositoryMocks(create, updateMany);
    const now = new Date("2026-10-27T06:00:00.000Z");
    const expiry = new Date(now.getTime() + 60_000);

    await expect(repository.tryAcquire("org-1", "lease-1", now, expiry)).resolves.toBe(true);

    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: "org-1",
        leaseToken: "lease-1",
        leaseExpiresAt: expiry,
        updatedAt: now,
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", leaseExpiresAt: { lte: now } },
      data: { leaseToken: "lease-1", leaseExpiresAt: expiry, updatedAt: now },
    });
    expect(lockDelegate.updateMany).toHaveBeenCalledOnce();
  });

  it("does not steal an active lease when the database compare-and-set updates no rows", async () => {
    const create = vi.fn().mockRejectedValue({ code: "P2002" });
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const { repository } = createRepositoryMocks(create, updateMany);

    await expect(
      repository.tryAcquire("org-1", "lease-2", new Date(), new Date(Date.now() + 60_000)),
    ).resolves.toBe(false);
  });

  it("renews and releases only the matching lease token", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { repository } = createRepositoryMocks(vi.fn(), updateMany);
    const now = new Date();
    const expiry = new Date(now.getTime() + 60_000);

    await expect(repository.renew("org-1", "lease-1", now, expiry)).resolves.toBe(true);
    await repository.release("org-1", "lease-1", now);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { organizationId: "org-1", leaseToken: "lease-1", leaseExpiresAt: { gt: now } },
      data: { leaseExpiresAt: expiry, updatedAt: now },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { organizationId: "org-1", leaseToken: "lease-1" },
      data: { leaseExpiresAt: now, updatedAt: now },
    });
  });

  it("recovers only still-running jobs for the requested organization", async () => {
    const { repository, runDelegate } = createRepositoryMocks();
    const completedAt = new Date();

    await expect(
      repository.recoverAbandonedRuns("org-1", "current-run", completedAt),
    ).resolves.toBe(1);

    expect(runDelegate.updateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", status: "Running", id: { not: "current-run" } },
      data: {
        status: "Failed",
        completedAt,
        errorCode: "STALE_RUN_RECOVERED",
      },
    });
  });
});
