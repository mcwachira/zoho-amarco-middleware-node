CREATE UNIQUE INDEX "EtimsReportingOperation_id_fiscalizationRequestId_key"
    ON "EtimsReportingOperation"("id", "fiscalizationRequestId");
CREATE TABLE "EtimsSubmissionPayload" (
    "operationId" VARCHAR(100) NOT NULL,
    "fiscalizationRequestId" VARCHAR(100) NOT NULL,
    "payloadVersion" INTEGER NOT NULL,
    "payloadHash" VARCHAR(64) NOT NULL,
    "submissionAttemptType" VARCHAR(20) NOT NULL DEFAULT 'submission',
    "submissionAttemptNumber" INTEGER NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EtimsSubmissionPayload_pkey" PRIMARY KEY ("operationId", "submissionAttemptNumber"),
    CONSTRAINT "EtimsSubmissionPayload_version_check" CHECK ("payloadVersion" = 1),
    CONSTRAINT "EtimsSubmissionPayload_hash_check" CHECK ("payloadHash" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "EtimsSubmissionPayload_attempt_check" CHECK ("submissionAttemptNumber" > 0),
    CONSTRAINT "EtimsSubmissionPayload_attemptType_check" CHECK ("submissionAttemptType" = 'submission'),
    CONSTRAINT "EtimsSubmissionPayload_operationId_fkey"
        FOREIGN KEY ("operationId", "fiscalizationRequestId")
        REFERENCES "EtimsReportingOperation"("id", "fiscalizationRequestId") ON DELETE RESTRICT,
    CONSTRAINT "EtimsSubmissionPayload_attempt_fkey"
        FOREIGN KEY ("operationId", "submissionAttemptType", "submissionAttemptNumber")
        REFERENCES "EtimsReportingAttempt"("operationId", "attemptType", "attemptNumber") ON DELETE RESTRICT
);

CREATE INDEX "EtimsSubmissionPayload_operationId_fiscalizationRequestId_idx"
    ON "EtimsSubmissionPayload"("operationId", "fiscalizationRequestId");
CREATE UNIQUE INDEX "EtimsSubmissionPayload_operationId_submissionAttemptType_submissionAttemptNumber_key"
    ON "EtimsSubmissionPayload"("operationId", "submissionAttemptType", "submissionAttemptNumber");

CREATE INDEX "EtimsSubmissionPayload_fiscalizationRequestId_idx"
    ON "EtimsSubmissionPayload"("fiscalizationRequestId");
