CREATE TABLE "ManualReviewCase" (
  "id" VARCHAR(100) NOT NULL,
  "fiscalizationRequestId" VARCHAR(100) NOT NULL,
  "operationId" VARCHAR(100) NOT NULL,
  "relatedAttemptIdsJson" TEXT NOT NULL,
  "observedState" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'open',
  "decisionSequence" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ManualReviewCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualReviewCase_status_check" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "ManualReviewCase_request_fkey" FOREIGN KEY ("fiscalizationRequestId")
    REFERENCES "FiscalizationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManualReviewCase_requestId_operationId_key"
  ON "ManualReviewCase"("fiscalizationRequestId", "operationId");
CREATE INDEX "ManualReviewCase_status_updatedAt_idx" ON "ManualReviewCase"("status", "updatedAt");

CREATE TABLE "ManualReviewDecision" (
  "id" VARCHAR(100) NOT NULL,
  "caseId" VARCHAR(100) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "operatorSubject" VARCHAR(100) NOT NULL,
  "requestedOutcome" VARCHAR(32) NOT NULL,
  "resolution" VARCHAR(32) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "evidenceReference" VARCHAR(500),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ManualReviewDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ManualReviewDecision_outcome_check" CHECK ("requestedOutcome" IN ('confirmed_success', 'confirmed_failure', 'still_unknown')),
  CONSTRAINT "ManualReviewDecision_resolution_check" CHECK ("resolution" IN ('confirmed', 'still_unknown', 'invalid_evidence')),
  CONSTRAINT "ManualReviewDecision_case_fkey" FOREIGN KEY ("caseId")
    REFERENCES "ManualReviewCase"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ManualReviewDecision_caseId_sequence_key"
  ON "ManualReviewDecision"("caseId", "sequence");
CREATE INDEX "ManualReviewDecision_caseId_recordedAt_idx"
  ON "ManualReviewDecision"("caseId", "recordedAt");
