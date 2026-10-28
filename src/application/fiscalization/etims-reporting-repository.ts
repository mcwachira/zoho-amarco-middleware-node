import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingOperationDetails,
  EtimsReportingState,
} from "../../domain/fiscalization/etims-reporting.js";
import type {
  EtimsSubmissionPayloadClaim,
  EtimsSubmissionPayloadRecord,
} from "./etims-submission-payload.js";

export interface EtimsReportingRepository {
  create(operation: EtimsReportingOperation): Promise<void>;
  findById(id: string): Promise<EtimsReportingOperationDetails | null>;
  findByFiscalizationRequestId(
    fiscalizationRequestId: string,
  ): Promise<EtimsReportingOperationDetails | null>;
  findReconciliationCandidates(limit: number): Promise<readonly EtimsReportingOperationDetails[]>;
  claimPending(claim: EtimsSubmissionPayloadClaim): Promise<EtimsReportingOperation | null>;
  findSubmissionPayload(
    operationId: string,
    submissionAttemptNumber: number,
  ): Promise<EtimsSubmissionPayloadRecord | null>;
  claimReconciliation(
    id: string,
    expectedState: "outcome_unknown" | "reconciliation_required",
    now: Date,
  ): Promise<EtimsReportingOperation | null>;
  transition(
    id: string,
    expectedState: EtimsReportingState,
    operation: EtimsReportingOperation,
  ): Promise<boolean>;
  completeAttempt(
    operation: EtimsReportingOperation,
    attempt: EtimsReportingAttempt,
  ): Promise<boolean>;
  markStaleInProgressOutcomeUnknown(staleBefore: Date, now: Date): Promise<number>;
  markStaleReconciliationRequired(staleBefore: Date, now: Date): Promise<number>;
}
