import { describe, expect, it, vi } from "vitest";

import { ZohoInvoiceSynchronizationService } from "../../src/application/zoho/zoho-invoice-synchronization.js";
import type {
  ZohoSyncRepository,
  ZohoSyncRun,
} from "../../src/application/zoho/zoho-sync-repository.js";
import type { ImportZohoInvoicesService } from "../../src/application/zoho/import-zoho-invoices.js";
import type { ZohoInvoiceImportResult } from "../../src/application/zoho/import-zoho-invoices.js";

function createRepository() {
  const locks = new Map<
    string,
    { organizationId: string; leaseToken: string; leaseExpiresAt: Date }
  >();
  const runs = new Map<string, ZohoSyncRun>();
  const repository: ZohoSyncRepository = {
    tryAcquire: async (organizationId, leaseToken, now, leaseExpiresAt) => {
      const current = locks.get(organizationId);
      if (current && current.leaseExpiresAt > now) return false;
      locks.set(organizationId, { organizationId, leaseToken, leaseExpiresAt });
      return true;
    },
    renew: async (organizationId, leaseToken, now, leaseExpiresAt) => {
      const lock = locks.get(organizationId);
      if (!lock || lock.leaseToken !== leaseToken || lock.leaseExpiresAt <= now) return false;
      locks.set(organizationId, { ...lock, leaseExpiresAt });
      return true;
    },
    release: async (organizationId, leaseToken, now) => {
      const lock = locks.get(organizationId);
      if (lock?.leaseToken === leaseToken)
        locks.set(organizationId, { ...lock, leaseExpiresAt: now });
    },
    createRun: async (run) => {
      runs.set(run.id, {
        ...run,
        status: "Running",
        completedAt: null,
        discovered: 0,
        imported: 0,
        duplicatesSkipped: 0,
        rejected: 0,
        failed: 0,
        pagesRetrieved: 0,
        paginationComplete: false,
        errorCode: null,
      });
    },
    completeRun: async (id, result) => {
      const run = runs.get(id);
      if (!run || run.status !== "Running") throw new Error("Run is not active.");
      runs.set(id, { ...run, ...result });
    },
    recoverAbandonedRuns: async (organizationId, exceptRunId, completedAt) => {
      let recovered = 0;
      for (const [id, run] of runs) {
        if (
          run.organizationId === organizationId &&
          id !== exceptRunId &&
          run.status === "Running"
        ) {
          runs.set(id, {
            ...run,
            status: "Failed",
            completedAt,
            errorCode: "STALE_RUN_RECOVERED",
          });
          recovered += 1;
        }
      }
      return recovered;
    },
    getLatest: async (organizationId) => {
      const organizationRuns = [...runs.values()].filter(
        (run) => run.organizationId === organizationId,
      );
      const run =
        organizationRuns.sort(
          (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
        )[0] ?? null;
      const lastSuccessfulRun =
        organizationRuns
          .filter((item) => item.status === "Succeeded" && item.paginationComplete)
          .sort(
            (left, right) =>
              (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0),
          )[0] ?? null;
      return { lock: locks.get(organizationId) ?? null, run, lastSuccessfulRun };
    },
  };
  return { repository, locks, runs };
}

function successImport(): ZohoInvoiceImportResult {
  return {
    state: "completed" as const,
    paginationComplete: true,
    discovered: 4,
    imported: 2,
    duplicatesSkipped: 1,
    rejected: 1,
    failed: 0,
    pagesRetrieved: 2,
    issues: [],
  };
}

function makeService(
  organizationId: string,
  repository: ZohoSyncRepository,
  execute: (signal?: AbortSignal) => Promise<ZohoInvoiceImportResult> = vi.fn(
    async (): Promise<ZohoInvoiceImportResult> => successImport(),
  ),
  options: ConstructorParameters<typeof ZohoInvoiceSynchronizationService>[3] = {},
) {
  return new ZohoInvoiceSynchronizationService(
    organizationId,
    { execute } as unknown as Pick<ImportZohoInvoicesService, "execute">,
    repository,
    { heartbeatMs: 10_000, leaseMs: 30_000, ...options },
  );
}

describe("ZohoInvoiceSynchronizationService", () => {
  it("persists initial and later full synchronization runs and safe operational status", async () => {
    const { repository, runs } = createRepository();
    let time = new Date("2026-10-27T06:00:00.000Z");
    let id = 0;
    const service = makeService("organization-a", repository, undefined, {
      now: () => time,
      generateId: () => `sync-${++id}`,
      automaticEnabled: true,
    });

    const first = await service.execute();
    expect(first).toMatchObject({
      state: "succeeded",
      run: {
        status: "Succeeded",
        discovered: 4,
        imported: 2,
        duplicatesSkipped: 1,
        rejected: 1,
        paginationComplete: true,
      },
    });

    time = new Date(time.getTime() + 60_000);
    await service.execute();
    const status = await service.getStatus();

    expect(runs.size).toBe(2);
    expect(status).toMatchObject({
      organizationId: "organization-a",
      automaticSyncEnabled: true,
      inProgress: false,
      checkpointMode: "full_catalog_scan",
      lastSuccessfulFullSyncAt: time,
    });
    expect(JSON.stringify(status)).not.toContain("sync-2");
  });

  it("keeps a partial pagination result from advancing the last successful full-scan time", async () => {
    const { repository } = createRepository();
    const execute = vi
      .fn()
      .mockResolvedValueOnce(successImport())
      .mockResolvedValueOnce({
        ...successImport(),
        state: "partial",
        paginationComplete: false,
        issues: [{ category: "invoice_list_failed", code: "ZOHO_TRANSPORT_ERROR" }],
      });
    let id = 0;
    const service = makeService("organization-a", repository, execute, {
      now: () => new Date(`2026-10-27T06:0${id}:00.000Z`),
      generateId: () => `run-${++id}`,
    });

    const successful = await service.execute();
    const partial = await service.execute();
    const status = await service.getStatus();

    expect(successful.state).toBe("succeeded");
    expect(partial.state).toBe("partial");
    expect(status.latestRun?.status).toBe("Partial");
    if (successful.state !== "succeeded") {
      throw new Error("Expected first synchronization run to succeed.");
    }
    expect(status.lastSuccessfulFullSyncAt).toEqual(successful.run.completedAt);
  });

  it("prevents overlapping work for the same organization using the shared lease", async () => {
    const { repository } = createRepository();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const importer = vi.fn(async () => {
      await waiting;
      return successImport();
    });
    const first = makeService("organization-a", repository, importer);
    const second = makeService("organization-a", repository);

    const firstRun = first.execute();
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    await expect(second.execute()).resolves.toMatchObject({ state: "busy" });
    finish();
    await expect(firstRun).resolves.toMatchObject({ state: "succeeded" });
  });

  it("allows organizations with different lease keys to synchronize independently", async () => {
    const { repository } = createRepository();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = makeService("organization-a", repository, async () => {
      await waiting;
      return successImport();
    });
    const second = makeService("organization-b", repository);

    const firstRun = first.execute();
    await expect(second.execute()).resolves.toMatchObject({ state: "succeeded" });
    finish();
    await expect(firstRun).resolves.toMatchObject({ state: "succeeded" });
  });

  it("recovers stale running job records without inferring invoice outcomes", async () => {
    const { repository, runs } = createRepository();
    runs.set("abandoned", {
      id: "abandoned",
      organizationId: "organization-a",
      status: "Running",
      startedAt: new Date("2026-10-27T05:00:00.000Z"),
      completedAt: null,
      discovered: 2,
      imported: 1,
      duplicatesSkipped: 0,
      rejected: 0,
      failed: 0,
      pagesRetrieved: 1,
      paginationComplete: false,
      errorCode: null,
    });
    let id = 0;
    const service = makeService("organization-a", repository, undefined, {
      now: () => new Date("2026-10-27T06:00:00.000Z"),
      generateId: () => `new-${++id}`,
    });

    await service.execute();

    expect(runs.get("abandoned")).toMatchObject({
      status: "Failed",
      errorCode: "STALE_RUN_RECOVERED",
      paginationComplete: false,
    });
  });

  it("aborts importing when the lease can no longer be renewed", async () => {
    const { repository } = createRepository();
    vi.spyOn(repository, "renew").mockResolvedValue(false);
    const importer = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<ReturnType<typeof successImport>>((resolve) => {
          signal?.addEventListener(
            "abort",
            () =>
              resolve({
                ...successImport(),
                state: "partial",
                paginationComplete: false,
                issues: [{ category: "synchronization_cancelled" }],
              }),
            { once: true },
          );
        }),
    );
    const service = makeService("organization-a", repository, importer, {
      leaseMs: 60,
      heartbeatMs: 5,
    });

    await expect(service.execute()).resolves.toMatchObject({
      state: "failed",
      run: { errorCode: "SYNCHRONIZATION_LOCK_LOST", paginationComplete: false },
    });
  });
});
