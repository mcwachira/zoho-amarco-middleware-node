export type KraReferenceCategory = "codes" | "item_classifications" | "branches" | "items";
export type KraReferenceProvider = "oscu" | "vscu";

export interface KraReferenceSyncScope {
  readonly provider: KraReferenceProvider;
  readonly adapterIdentity: string;
  readonly taxpayerTin: string;
  readonly branchId: string;
  readonly category: KraReferenceCategory;
}

export interface KraReferenceSyncState extends KraReferenceSyncScope {
  readonly id: string;
  readonly lastAttemptAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly providerTimestamp: string | null;
  readonly providerCursor: string | null;
  readonly activeVersion: string | null;
  readonly attemptStatus: string;
  readonly lastErrorCategory: string | null;
  readonly correlationId: string | null;
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface KraReferenceSyncRepository {
  find(scope: KraReferenceSyncScope): Promise<KraReferenceSyncState | null>;
  tryAcquire(
    scope: KraReferenceSyncScope,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  renew(
    scope: KraReferenceSyncScope,
    leaseToken: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean>;
  release(scope: KraReferenceSyncScope, leaseToken: string): Promise<void>;
  recordAttempt(
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
  ): Promise<boolean>;
}
