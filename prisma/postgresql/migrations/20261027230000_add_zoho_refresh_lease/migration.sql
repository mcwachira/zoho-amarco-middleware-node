ALTER TABLE "ZohoToken"
    ADD COLUMN "refreshLeaseToken" VARCHAR(100),
    ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "ZohoToken"
    ADD CONSTRAINT "ZohoToken_refresh_lease_pair_check"
    CHECK (("refreshLeaseToken" IS NULL) = ("refreshLeaseExpiresAt" IS NULL));
