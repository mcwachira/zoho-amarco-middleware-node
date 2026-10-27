export const ETIMS_REPORTING_STATES = [
  "not_configured",
  "blocked",
  "pending",
  "in_progress",
  "accepted",
  "rejected",
  "outcome_unknown",
  "reconciliation_required",
] as const;

export type EtimsReportingState = (typeof ETIMS_REPORTING_STATES)[number];
export type EtimsAdapterType = "vscu" | "oscu";

export interface EtimsReportingAttempt {
  readonly id: string;
  readonly operationId: string;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
  readonly outcome: "accepted" | "rejected" | "outcome_unknown" | null;
  readonly providerReference: string | null;
  readonly errorCategory: string | null;
  readonly errorMessage: string | null;
}

export interface EtimsReportingOperation {
  readonly id: string;
  readonly fiscalizationRequestId: string;
  readonly zohoInvoiceId: string;
  readonly adapterType: EtimsAdapterType | null;
  readonly adapterConfigurationId: string | null;
  readonly correlationId: string;
  readonly status: EtimsReportingState;
  readonly payloadHash: string;
  readonly attemptNumber: number;
  readonly providerReference: string | null;
  readonly providerMetadataJson: string | null;
  readonly errorCategory: string | null;
  readonly errorMessage: string | null;
  readonly reconciliationRequired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EtimsReportingOperationDetails {
  readonly operation: EtimsReportingOperation;
  readonly attempts: readonly EtimsReportingAttempt[];
}

const allowedTransitions: Readonly<Record<EtimsReportingState, readonly EtimsReportingState[]>> = {
  not_configured: [],
  blocked: [],
  pending: ["blocked", "in_progress"],
  in_progress: ["accepted", "rejected", "outcome_unknown"],
  accepted: [],
  rejected: [],
  outcome_unknown: ["reconciliation_required"],
  reconciliation_required: ["accepted", "rejected", "pending", "reconciliation_required"],
};

export class InvalidEtimsReportingTransitionError extends Error {
  constructor(from: EtimsReportingState, to: EtimsReportingState) {
    super(`Invalid eTIMS reporting transition: ${from} -> ${to}.`);
    this.name = "InvalidEtimsReportingTransitionError";
  }
}

export function assertEtimsReportingTransition(
  from: EtimsReportingState,
  to: EtimsReportingState,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new InvalidEtimsReportingTransitionError(from, to);
  }
}

export function isEtimsAdapterType(value: unknown): value is EtimsAdapterType {
  return value === "vscu" || value === "oscu";
}

export function isEtimsReportingState(value: unknown): value is EtimsReportingState {
  return typeof value === "string" && ETIMS_REPORTING_STATES.some((state) => state === value);
}
