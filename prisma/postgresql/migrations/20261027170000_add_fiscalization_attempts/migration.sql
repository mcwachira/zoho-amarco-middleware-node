CREATE TABLE "FiscalizationAttempt" (
    "id" VARCHAR(100) NOT NULL,
    "fiscalizationRequestId" VARCHAR(100) NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "outcome" VARCHAR(32),
    "receiptNumber" VARCHAR(100),
    "issuedAt" TIMESTAMP(3),
    "errorCode" VARCHAR(100),
    "errorMessage" VARCHAR(2000),

    CONSTRAINT "FiscalizationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FiscalizationAttempt_fiscalizationRequestId_attemptNumber_key"
ON "FiscalizationAttempt"("fiscalizationRequestId", "attemptNumber");

CREATE INDEX "FiscalizationAttempt_fiscalizationRequestId_startedAt_idx"
ON "FiscalizationAttempt"("fiscalizationRequestId", "startedAt");

ALTER TABLE "EtimsReportingOperation"
ADD COLUMN "reconciliationAttemptNumber" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "EtimsReportingAttempt"
ADD COLUMN "attemptType" VARCHAR(20) NOT NULL DEFAULT 'submission';

DROP INDEX "EtimsReportingAttempt_operationId_attemptNumber_key";
CREATE UNIQUE INDEX "EtimsReportingAttempt_operationId_attemptType_attemptNumber_key"
ON "EtimsReportingAttempt"("operationId", "attemptType", "attemptNumber");

ALTER TABLE "EtimsReportingAttempt"
DROP CONSTRAINT "EtimsReportingAttempt_outcome_check";
ALTER TABLE "EtimsReportingAttempt"
ADD CONSTRAINT "EtimsReportingAttempt_outcome_check"
CHECK ("outcome" IS NULL OR "outcome" IN ('accepted', 'rejected', 'outcome_unknown', 'confirmed_not_found'));

ALTER TABLE "FiscalizationAttempt"
ADD CONSTRAINT "FiscalizationAttempt_fiscalizationRequestId_fkey"
FOREIGN KEY ("fiscalizationRequestId") REFERENCES "FiscalizationRecord"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
