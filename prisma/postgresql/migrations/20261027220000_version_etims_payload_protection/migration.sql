-- Additive key/protection metadata. Existing AES-GCM records use the original
-- AAD layout and are therefore explicitly classified as protection version 1.
ALTER TABLE "EtimsSubmissionPayload"
    ADD COLUMN "protectionVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "encryptionKeyId" VARCHAR(100) NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE "EtimsSubmissionPayload"
    ADD CONSTRAINT "EtimsSubmissionPayload_protectionVersion_check"
        CHECK ("protectionVersion" IN (1, 2)),
    ADD CONSTRAINT "EtimsSubmissionPayload_encryptionKeyId_check"
        CHECK ("encryptionKeyId" ~ '^[A-Za-z0-9._-]{1,100}$');
