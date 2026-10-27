import {
  isEtimsAdapterType,
  isEtimsReportingState,
  type EtimsReportingAttempt,
  type EtimsReportingOperation,
  type EtimsReportingOperationDetails,
} from "../../domain/fiscalization/etims-reporting.js";

interface EtimsOperationRow {
  id: string;
  fiscalizationRequestId: string;
  zohoInvoiceId: string;
  adapterType: string | null;
  adapterConfigurationId: string | null;
  correlationId: string;
  status: string;
  payloadHash: string;
  attemptNumber: number;
  providerReference: string | null;
  providerMetadataJson: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  reconciliationRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface EtimsAttemptRow {
  id: string;
  operationId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  outcome: string | null;
  providerReference: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
}

export function mapEtimsOperation(row: EtimsOperationRow): EtimsReportingOperation {
  if (!isEtimsReportingState(row.status)) {
    throw new Error("Stored eTIMS reporting operation has an invalid state.");
  }
  if (row.adapterType !== null && !isEtimsAdapterType(row.adapterType)) {
    throw new Error("Stored eTIMS reporting operation has an invalid adapter type.");
  }
  return { ...row, status: row.status, adapterType: row.adapterType };
}

export function mapEtimsAttempt(row: EtimsAttemptRow): EtimsReportingAttempt {
  if (
    row.outcome !== null &&
    row.outcome !== "accepted" &&
    row.outcome !== "rejected" &&
    row.outcome !== "outcome_unknown"
  ) {
    throw new Error("Stored eTIMS reporting attempt has an invalid outcome.");
  }
  return { ...row, outcome: row.outcome };
}

export function mapEtimsDetails(
  operationRow: EtimsOperationRow | null,
  attemptRows: readonly EtimsAttemptRow[],
): EtimsReportingOperationDetails | null {
  if (operationRow === null) {
    return null;
  }
  return {
    operation: mapEtimsOperation(operationRow),
    attempts: attemptRows.map(mapEtimsAttempt),
  };
}
