CREATE TABLE "EtimsReportingOperation" (
    "id" VARCHAR(100) NOT NULL,
    "fiscalizationRequestId" VARCHAR(100) NOT NULL,
    "zohoInvoiceId" VARCHAR(255) NOT NULL,
    "adapterType" VARCHAR(10),
    "adapterConfigurationId" VARCHAR(255),
    "correlationId" VARCHAR(100) NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 0,
    "providerReference" VARCHAR(255),
    "providerMetadataJson" TEXT,
    "errorCategory" VARCHAR(100),
    "errorMessage" VARCHAR(500),
    "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "EtimsReportingOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EtimsReportingOperation_status_check"
        CHECK ("status" IN ('not_configured', 'blocked', 'pending', 'in_progress', 'accepted', 'rejected', 'outcome_unknown', 'reconciliation_required')),
    CONSTRAINT "EtimsReportingOperation_adapterType_check"
        CHECK ("adapterType" IS NULL OR "adapterType" IN ('vscu', 'oscu'))
);

CREATE UNIQUE INDEX "EtimsReportingOperation_fiscalizationRequestId_key"
    ON "EtimsReportingOperation"("fiscalizationRequestId");
CREATE UNIQUE INDEX "EtimsReportingOperation_correlationId_key"
    ON "EtimsReportingOperation"("correlationId");
CREATE INDEX "EtimsReportingOperation_status_updatedAt_idx"
    ON "EtimsReportingOperation"("status", "updatedAt");
CREATE INDEX "EtimsReportingOperation_zohoInvoiceId_idx"
    ON "EtimsReportingOperation"("zohoInvoiceId");

CREATE TABLE "EtimsReportingAttempt" (
    "id" VARCHAR(100) NOT NULL,
    "operationId" VARCHAR(100) NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "outcome" VARCHAR(32),
    "providerReference" VARCHAR(255),
    "errorCategory" VARCHAR(100),
    "errorMessage" VARCHAR(500),
    CONSTRAINT "EtimsReportingAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EtimsReportingAttempt_outcome_check"
        CHECK ("outcome" IS NULL OR "outcome" IN ('accepted', 'rejected', 'outcome_unknown'))
);

CREATE UNIQUE INDEX "EtimsReportingAttempt_operationId_attemptNumber_key"
    ON "EtimsReportingAttempt"("operationId", "attemptNumber");
CREATE INDEX "EtimsReportingAttempt_operationId_startedAt_idx"
    ON "EtimsReportingAttempt"("operationId", "startedAt");
