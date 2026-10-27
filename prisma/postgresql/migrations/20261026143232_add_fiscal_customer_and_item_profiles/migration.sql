-- CreateTable
CREATE TABLE "FiscalCustomerProfile" (
    "id" VARCHAR(100) NOT NULL,
    "zohoCustomerId" VARCHAR(255) NOT NULL,
    "companyName" VARCHAR(30) NOT NULL,
    "clientPin" VARCHAR(14) NOT NULL,
    "headquarters" VARCHAR(30) NOT NULL,
    "address" VARCHAR(30) NOT NULL,
    "postalCodeAndCity" VARCHAR(30) NOT NULL,
    "exemptionNumber" VARCHAR(30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalCustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FiscalItemProfile" (
    "id" VARCHAR(100) NOT NULL,
    "zohoItemId" VARCHAR(255) NOT NULL,
    "measureUnit" VARCHAR(3) NOT NULL,
    "hsCode" VARCHAR(10) NOT NULL,
    "hsName" VARCHAR(20) NOT NULL,
    "vatClass" VARCHAR(1) NOT NULL,
    "vatGroupRate" VARCHAR(20) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FiscalItemProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FiscalCustomerProfile_zohoCustomerId_key" ON "FiscalCustomerProfile"("zohoCustomerId");

-- CreateIndex
CREATE INDEX "FiscalCustomerProfile_clientPin_idx" ON "FiscalCustomerProfile"("clientPin");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalItemProfile_zohoItemId_key" ON "FiscalItemProfile"("zohoItemId");
