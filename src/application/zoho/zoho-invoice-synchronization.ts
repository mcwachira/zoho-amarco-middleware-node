import { randomUUID } from "node:crypto";
import type { ImportZohoInvoicesService } from "./import-zoho-invoices.js";
import type { ZohoSyncRepository, ZohoSyncRun } from "./zoho-sync-repository.js";

const DEFAULT_LEASE_MS = 2 * 60 * 1000;

export type ZohoInvoiceSynchronizationResult =
  | { readonly state: "busy"; readonly run: ZohoSyncRun | null }
  | { readonly state: "succeeded" | "partial" | "failed"; readonly run: ZohoSyncRun };

export class ZohoInvoiceSynchronizationService {
  constructor(
    private readonly organizationId: string,
    private readonly importer: Pick<ImportZohoInvoicesService, "execute">,
    private readonly repository: ZohoSyncRepository,
    private readonly options: {
      readonly now?: () => Date;
      readonly generateId?: () => string;
      readonly leaseMs?: number;
      readonly heartbeatMs?: number;
      readonly automaticEnabled?: boolean;
    } = {},
  ) {
    if (!organizationId.trim()) {
      throw new Error("Zoho organization ID is required for synchronization.");
    }

    const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    const heartbeatMs = options.heartbeatMs ?? Math.floor(leaseMs / 3);
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 3 ||
      !Number.isSafeInteger(heartbeatMs) ||
      heartbeatMs < 1 ||
      heartbeatMs >= leaseMs
    ) {
      throw new Error("Synchronization lease and heartbeat intervals are invalid.");
    }
  }

  async getStatus(): Promise<{
    readonly organizationId: string;
    readonly inProgress: boolean;
    readonly lockExpiresAt: Date | null;
    readonly latestRun: ZohoSyncRun | null;
    readonly lastSuccessfulFullSyncAt: Date | null;
    readonly checkpointMode: "full_catalog_scan";
    readonly automaticSyncEnabled: boolean;
  }> {
    const now = this.options.now?.() ?? new Date();
    let status = await this.repository.getLatest(this.organizationId);
    if (
      status.run?.status === "Running" &&
      (status.lock === null || status.lock.leaseExpiresAt <= now)
    ) {
      await this.repository.recoverAbandonedRuns(this.organizationId, "", now);
      status = await this.repository.getLatest(this.organizationId);
    }

    return {
      organizationId: this.organizationId,
      inProgress: status.lock !== null && status.lock.leaseExpiresAt > now,
      lockExpiresAt: status.lock?.leaseExpiresAt ?? null,
      latestRun: status.run,
      lastSuccessfulFullSyncAt: status.lastSuccessfulRun?.completedAt ?? null,
      checkpointMode: "full_catalog_scan",
      automaticSyncEnabled: this.options.automaticEnabled ?? false,
    };
  }

  async execute(): Promise<ZohoInvoiceSynchronizationResult> {
    const now = this.options.now ?? (() => new Date());
    const generateId = this.options.generateId ?? randomUUID;
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const heartbeatMs = this.options.heartbeatMs ?? Math.floor(leaseMs / 3);
    const runId = generateId();
    const leaseToken = generateId();
    const startedAt = now();
    const leaseExpiresAt = new Date(startedAt.getTime() + leaseMs);

    if (
      !(await this.repository.tryAcquire(
        this.organizationId,
        leaseToken,
        startedAt,
        leaseExpiresAt,
      ))
    ) {
      const current = await this.repository.getLatest(this.organizationId);
      return { state: "busy", run: current.run };
    }

    try {
      await this.repository.recoverAbandonedRuns(this.organizationId, runId, startedAt);
      await this.repository.createRun({
        id: runId,
        organizationId: this.organizationId,
        startedAt,
      });
    } catch (error: unknown) {
      await this.repository.release(this.organizationId, leaseToken, now());
      throw error;
    }

    const abortController = new AbortController();
    let lockLost = false;
    let heartbeatRunning = false;
    let heartbeatPromise: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning || lockLost) return;
      heartbeatRunning = true;
      heartbeatPromise = this.repository
        .renew(this.organizationId, leaseToken, now(), new Date(now().getTime() + leaseMs))
        .then((renewed) => {
          if (!renewed) {
            lockLost = true;
            abortController.abort();
          }
        })
        .catch(() => {
          lockLost = true;
          abortController.abort();
        })
        .finally(() => {
          heartbeatRunning = false;
        });
    }, heartbeatMs);
    heartbeat.unref();

    let completion: Omit<ZohoSyncRun, "id" | "organizationId" | "startedAt"> | undefined;
    try {
      const imported = await this.importer.execute(abortController.signal);
      const interrupted = lockLost || abortController.signal.aborted;
      const errorCode = interrupted
        ? "SYNCHRONIZATION_LOCK_LOST"
        : (imported.issues[0]?.code ?? imported.issues[0]?.category ?? null);
      completion = {
        status:
          interrupted || imported.state === "failed"
            ? "Failed"
            : imported.state === "partial"
              ? "Partial"
              : "Succeeded",
        completedAt: now(),
        discovered: imported.discovered,
        imported: imported.imported,
        duplicatesSkipped: imported.duplicatesSkipped,
        rejected: imported.rejected,
        failed: imported.failed,
        pagesRetrieved: imported.pagesRetrieved,
        paginationComplete: imported.paginationComplete,
        errorCode,
      };
    } catch {
      completion = {
        status: "Failed",
        completedAt: now(),
        discovered: 0,
        imported: 0,
        duplicatesSkipped: 0,
        rejected: 0,
        failed: 1,
        pagesRetrieved: 0,
        paginationComplete: false,
        errorCode: "SYNCHRONIZATION_FAILED",
      };
    } finally {
      clearInterval(heartbeat);
      await heartbeatPromise;
    }

    if (!completion) {
      throw new Error("Synchronization run did not produce a completion result.");
    }

    try {
      await this.repository.completeRun(runId, completion);
    } finally {
      await this.repository.release(this.organizationId, leaseToken, now());
    }
    const run: ZohoSyncRun = {
      id: runId,
      organizationId: this.organizationId,
      startedAt,
      ...completion,
    };
    const state =
      completion.status === "Succeeded"
        ? "succeeded"
        : completion.status === "Partial"
          ? "partial"
          : "failed";
    return { state, run };
  }
}
