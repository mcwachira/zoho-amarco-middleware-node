export type ZohoSyncRunStatus = "Running" | "Succeeded" | "Partial" | "Failed";

export interface ZohoSyncRun {
  readonly id: string;
  readonly organizationId: string;
  readonly status: ZohoSyncRunStatus;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly discovered: number;
  readonly imported: number;
  readonly duplicatesSkipped: number;
  readonly rejected: number;
  readonly failed: number;
  readonly pagesRetrieved: number;
  readonly paginationComplete: boolean;
  readonly errorCode: string | null;
}

export interface ZohoSyncLock {
  readonly organizationId: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface ZohoSyncRepository {
  tryAcquire(
    organizationId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  renew(
    organizationId: string,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  release(organizationId: string, leaseToken: string, now: Date): Promise<void>;
  createRun(run: Pick<ZohoSyncRun, "id" | "organizationId" | "startedAt">): Promise<void>;
  completeRun(
    id: string,
    result: Omit<ZohoSyncRun, "id" | "organizationId" | "startedAt">,
  ): Promise<void>;
  recoverAbandonedRuns(
    organizationId: string,
    exceptRunId: string,
    completedAt: Date,
  ): Promise<number>;
  getLatest(organizationId: string): Promise<{
    readonly lock: ZohoSyncLock | null;
    readonly run: ZohoSyncRun | null;
    readonly lastSuccessfulRun: ZohoSyncRun | null;
  }>;
}
