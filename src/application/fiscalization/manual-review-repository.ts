export type ManualReviewResolution = "operator_attested" | "still_unknown" | "invalid_evidence";
export type ManualReviewOutcome =
  "confirmed_success" | "confirmed_failure" | "still_unknown" | "escalated" | "investigation_note";

export interface ManualReviewDecision {
  readonly id: string;
  readonly caseId: string;
  readonly sequence: number;
  readonly operatorSubject: string;
  readonly requestedOutcome: ManualReviewOutcome;
  readonly resolution: ManualReviewResolution;
  readonly reason: string;
  readonly evidenceReference: string | null;
  readonly recordedAt: Date;
}

export interface ManualReviewCase {
  readonly id: string;
  readonly fiscalizationRequestId: string;
  readonly operationId: string;
  readonly relatedAttemptIds: readonly string[];
  readonly observedState: string;
  readonly reason: string;
  readonly initiatingOperatorSubject: string;
  readonly resolvingOperatorSubject: string | null;
  readonly resolvedAt: Date | null;
  readonly status: "open" | "resolved";
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decisions: readonly ManualReviewDecision[];
}

export interface OpenManualReviewInput {
  readonly id: string;
  readonly fiscalizationRequestId: string;
  readonly operationId: string;
  readonly relatedAttemptIds: readonly string[];
  readonly observedState: string;
  readonly reason: string;
  readonly initiatingOperatorSubject: string;
  readonly createdAt: Date;
}

export interface RecordManualReviewDecisionInput {
  readonly id: string;
  readonly caseId: string;
  readonly operatorSubject: string;
  readonly requestedOutcome: ManualReviewOutcome;
  readonly resolution: ManualReviewResolution;
  readonly reason: string;
  readonly evidenceReference: string | null;
  readonly recordedAt: Date;
}

export interface ManualReviewRepository {
  openCase(input: OpenManualReviewInput): Promise<ManualReviewCase>;
  getCase(id: string): Promise<ManualReviewCase | null>;
  getByRequestAndOperation(
    requestId: string,
    operationId: string,
  ): Promise<ManualReviewCase | null>;
  getByRequestId(requestId: string): Promise<ManualReviewCase | null>;
  listUnresolved(input: { limit: number; offset: number }): Promise<readonly ManualReviewCase[]>;
  recordDecision(input: RecordManualReviewDecisionInput): Promise<ManualReviewCase>;
}
