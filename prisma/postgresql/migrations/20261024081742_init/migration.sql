-- CreateTable
CREATE TABLE "FiscalizationRecord" (
    "id" VARCHAR(100) NOT NULL,
    "zohoInvoiceId" VARCHAR(255) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'Pending',
    "receiptNumber" VARCHAR(100),
    "issuedAt" TIMESTAMP(3),
    "failureCode" VARCHAR(100),
    "failureMessage" VARCHAR(2000),
    "outcomeUnknownReason" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalizationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalizationRecord_zohoInvoiceId_key" ON "FiscalizationRecord"("zohoInvoiceId");

-- CreateIndex
CREATE INDEX "FiscalizationRecord_status_idx" ON "FiscalizationRecord"("status");
