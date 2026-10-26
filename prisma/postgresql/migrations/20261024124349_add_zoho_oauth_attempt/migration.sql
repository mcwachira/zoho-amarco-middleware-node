-- CreateTable
CREATE TABLE "ZohoOAuthAttempt" (
    "id" VARCHAR(100) NOT NULL,
    "stateHash" VARCHAR(64) NOT NULL,
    "encryptedCodeVerifier" VARCHAR(512) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZohoOAuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZohoOAuthAttempt_stateHash_key" ON "ZohoOAuthAttempt"("stateHash");

-- CreateIndex
CREATE INDEX "ZohoOAuthAttempt_expiresAt_idx" ON "ZohoOAuthAttempt"("expiresAt");
