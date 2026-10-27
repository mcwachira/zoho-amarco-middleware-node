import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingOperationDetails,
  EtimsReportingState,
} from "../../domain/fiscalization/etims-reporting.js";

export interface EtimsReportingRepository {
  create(operation: EtimsReportingOperation): Promise<void>;
  findById(id: string): Promise<EtimsReportingOperationDetails | null>;
  findByFiscalizationRequestId(
    fiscalizationRequestId: string,
  ): Promise<EtimsReportingOperationDetails | null>;
  claimPending(id: string, now: Date): Promise<EtimsReportingOperation | null>;
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
}
