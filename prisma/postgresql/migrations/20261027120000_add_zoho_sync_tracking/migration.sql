CREATE TABLE "ZohoSyncRun" (
    "id" VARCHAR(100) NOT NULL,
    "organizationId" VARCHAR(255) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'Running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "discovered" INTEGER NOT NULL DEFAULT 0,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "duplicatesSkipped" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "pagesRetrieved" INTEGER NOT NULL DEFAULT 0,
    "paginationComplete" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" VARCHAR(100),
    CONSTRAINT "ZohoSyncRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ZohoSyncRun_organizationId_startedAt_idx"
    ON "ZohoSyncRun"("organizationId", "startedAt");

CREATE TABLE "ZohoSyncLock" (
    "organizationId" VARCHAR(255) NOT NULL,
    "leaseToken" VARCHAR(100) NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ZohoSyncLock_pkey" PRIMARY KEY ("organizationId")
);
