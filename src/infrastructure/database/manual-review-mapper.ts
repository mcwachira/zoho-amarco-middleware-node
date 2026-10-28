import type { ManualReviewCase } from "../../application/fiscalization/manual-review-repository.js";

export function toManualReviewCase(row: {
  id: string;
  fiscalizationRequestId: string;
  operationId: string;
  relatedAttemptIdsJson: string;
  observedState: string;
  reason: string;
  initiatingOperatorSubject: string;
  resolvingOperatorSubject: string | null;
  resolvedAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  decisions: readonly {
    id: string;
    caseId: string;
    sequence: number;
    operatorSubject: string;
    requestedOutcome: string;
    resolution: string;
    reason: string;
    evidenceReference: string | null;
    recordedAt: Date;
  }[];
}): ManualReviewCase {
  if (row.status !== "open" && row.status !== "resolved")
    throw new Error("Invalid persisted manual review status.");
  const allowedOutcomes = new Set([
    "confirmed_success",
    "confirmed_failure",
    "still_unknown",
    "escalated",
    "investigation_note",
  ]);
  const allowedResolutions = new Set(["operator_attested", "still_unknown", "invalid_evidence"]);
  if (
    row.decisions.some(
      (decision) =>
        !allowedOutcomes.has(decision.requestedOutcome) ||
        !allowedResolutions.has(decision.resolution),
    )
  ) {
    throw new Error("Invalid persisted manual review audit value.");
  }
  let attemptIds: unknown;
  try {
    attemptIds = JSON.parse(row.relatedAttemptIdsJson);
  } catch {
    attemptIds = [];
  }
  return {
    id: row.id,
    fiscalizationRequestId: row.fiscalizationRequestId,
    operationId: row.operationId,
    relatedAttemptIds: Array.isArray(attemptIds)
      ? attemptIds.filter((value): value is string => typeof value === "string")
      : [],
    observedState: row.observedState,
    reason: row.reason,
    initiatingOperatorSubject: row.initiatingOperatorSubject,
    resolvingOperatorSubject: row.resolvingOperatorSubject,
    resolvedAt: row.resolvedAt,
    status: row.status === "resolved" ? "resolved" : "open",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    decisions: row.decisions.map((decision) => ({
      id: decision.id,
      caseId: decision.caseId,
      sequence: decision.sequence,
      operatorSubject: decision.operatorSubject,
      requestedOutcome:
        decision.requestedOutcome as ManualReviewCase["decisions"][number]["requestedOutcome"],
      resolution: decision.resolution as ManualReviewCase["decisions"][number]["resolution"],
      reason: decision.reason,
      evidenceReference: decision.evidenceReference,
      recordedAt: decision.recordedAt,
    })),
  };
}
