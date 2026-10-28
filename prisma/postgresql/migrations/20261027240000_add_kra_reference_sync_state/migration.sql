CREATE TABLE "KraReferenceSyncState" (
  "id" VARCHAR(100) NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "adapterIdentity" VARCHAR(255) NOT NULL,
  "taxpayerTin" VARCHAR(11) NOT NULL,
  "branchId" VARCHAR(2) NOT NULL,
  "category" VARCHAR(40) NOT NULL,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "providerTimestamp" VARCHAR(14),
  "providerCursor" VARCHAR(255),
  "activeVersion" VARCHAR(100),
  "attemptStatus" VARCHAR(32) NOT NULL DEFAULT 'not_attempted',
  "lastErrorCategory" VARCHAR(50),
  "correlationId" VARCHAR(100),
  "leaseToken" VARCHAR(100),
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KraReferenceSyncState_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KraReferenceSyncState_scope_key" ON "KraReferenceSyncState"("provider", "adapterIdentity", "taxpayerTin", "branchId", "category");
CREATE INDEX "KraReferenceSyncState_attemptStatus_updatedAt_idx" ON "KraReferenceSyncState"("attemptStatus", "updatedAt");
