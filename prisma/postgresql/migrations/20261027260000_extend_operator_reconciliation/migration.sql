ALTER TABLE "ManualReviewCase" ADD COLUMN IF NOT EXISTS "initiatingOperatorSubject" VARCHAR(100) NOT NULL DEFAULT 'legacy-operator';
ALTER TABLE "ManualReviewCase" ALTER COLUMN "initiatingOperatorSubject" DROP DEFAULT;
ALTER TABLE "ManualReviewCase" ADD COLUMN IF NOT EXISTS "resolvingOperatorSubject" VARCHAR(100);
ALTER TABLE "ManualReviewCase" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);

ALTER TABLE "ManualReviewDecision" DROP CONSTRAINT IF EXISTS "ManualReviewDecision_outcome_check";
UPDATE "ManualReviewDecision" SET "resolution" = 'operator_attested' WHERE "resolution" = 'confirmed';
UPDATE "ManualReviewCase" c
SET "resolvingOperatorSubject" = d."operatorSubject", "resolvedAt" = d."recordedAt"
FROM "ManualReviewDecision" d
WHERE d."caseId" = c."id" AND d."sequence" = c."decisionSequence" AND c."status" = 'resolved';
ALTER TABLE "ManualReviewDecision" ADD CONSTRAINT "ManualReviewDecision_outcome_check"
  CHECK ("requestedOutcome" IN ('confirmed_success', 'confirmed_failure', 'still_unknown', 'escalated', 'investigation_note'));
ALTER TABLE "ManualReviewDecision" DROP CONSTRAINT IF EXISTS "ManualReviewDecision_resolution_check";
ALTER TABLE "ManualReviewDecision" ADD CONSTRAINT "ManualReviewDecision_resolution_check"
  CHECK ("resolution" IN ('operator_attested', 'still_unknown', 'invalid_evidence'));
