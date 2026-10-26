-- CreateTable
CREATE TABLE "ZohoToken" (
    "id" VARCHAR(20) NOT NULL DEFAULT 'primary',
    "encryptedAccessToken" VARCHAR(2048) NOT NULL,
    "encryptedRefreshToken" VARCHAR(2048),
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "apiDomain" VARCHAR(255) NOT NULL,
    "scopes" VARCHAR(2000) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZohoToken_pkey" PRIMARY KEY ("id")
);
