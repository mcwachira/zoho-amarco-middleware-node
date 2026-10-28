ALTER TABLE "FiscalizationRecord"
  ADD COLUMN "outcomeProvenance" VARCHAR(24);

ALTER TABLE "EtimsReportingOperation"
  ADD COLUMN "simulated" BOOLEAN;

CREATE TABLE "ZohoFiscalizationWritebackOperation" (
  "id" VARCHAR(100) NOT NULL,
  "fiscalizationRequestId" VARCHAR(100) NOT NULL,
  "zohoInvoiceId" VARCHAR(255) NOT NULL,
  "organizationId" VARCHAR(128) NOT NULL,
  "correlationId" VARCHAR(100) NOT NULL,
  "payloadHash" VARCHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "writtenCustomFieldIdsJson" TEXT NOT NULL,
  "errorCategory" VARCHAR(100),
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ZohoFiscalizationWritebackOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ZohoFiscalizationWritebackOperation_request_fkey"
    FOREIGN KEY ("fiscalizationRequestId") REFERENCES "FiscalizationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ZohoFiscalizationWritebackOperation_request_key"
  ON "ZohoFiscalizationWritebackOperation"("fiscalizationRequestId");
CREATE UNIQUE INDEX "ZohoFiscalizationWritebackOperation_correlation_key"
  ON "ZohoFiscalizationWritebackOperation"("correlationId");
CREATE INDEX "ZohoFiscalizationWritebackOperation_status_lease_idx"
  ON "ZohoFiscalizationWritebackOperation"("status", "leaseExpiresAt");
