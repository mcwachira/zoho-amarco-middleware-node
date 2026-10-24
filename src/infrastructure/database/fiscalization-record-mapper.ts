import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";

import {
  fiscalizationStatuses,
  type FiscalizationStatus,
} from "../../domain/fiscalization/status.js";

export interface FiscalizationRecordRow {
  id: string;
  zohoInvoiceId: string;
  status: string;
  receiptNumber: string | null;
  issuedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  outcomeUnknownReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function isFiscalizationStatus(value: string): value is FiscalizationStatus {
  return (fiscalizationStatuses as readonly string[]).includes(value);
}

export function toDomainRecord(row: FiscalizationRecordRow): FiscalizationRecord {
  if (!isFiscalizationStatus(row.status)) {
    throw new Error(`Invalid fiscalization status in database: "${row.status}".`);
  }

  // Reject invalid dates before constructing the domain record.
  const dates = [row.createdAt, row.updatedAt];

  if (row.issuedAt !== null) {
    dates.push(row.issuedAt);
  }

  if (dates.some((date) => Number.isNaN(date.getTime()))) {
    throw new Error("Database record contains an invalid date.");
  }
  const hasReceiptNumber = row.receiptNumber !== null;
  const hasIssuedAt = row.issuedAt !== null;

  if (hasReceiptNumber !== hasIssuedAt) {
    throw new Error("Database record contains incomplete receipt information.");
  }

  const hasFailureCode = row.failureCode !== null;
  const hasFailureMessage = row.failureMessage !== null;

  if (hasFailureCode !== hasFailureMessage) {
    throw new Error("Database record contains incomplete failure information.");
  }

  // Ensure the stored outcome data agrees with the fiscalization status.
  switch (row.status) {
    case "Pending":
    case "InProgress":
      if (hasReceiptNumber || hasFailureCode || row.outcomeUnknownReason !== null) {
        throw new Error(`Database record in "${row.status}" status contains outcome data.`);
      }
      break;

    case "Succeeded":
      if (!hasReceiptNumber || hasFailureCode || row.outcomeUnknownReason !== null) {
        throw new Error("Succeeded database record contains inconsistent outcome data.");
      }
      break;

    case "Failed":
      if (hasReceiptNumber || !hasFailureCode || row.outcomeUnknownReason !== null) {
        throw new Error("Failed database record contains inconsistent outcome data.");
      }
      break;

    case "OutcomeUnknown":
      if (
        hasReceiptNumber ||
        hasFailureCode ||
        row.outcomeUnknownReason === null ||
        row.outcomeUnknownReason.trim().length === 0
      ) {
        throw new Error("OutcomeUnknown database record contains inconsistent outcome data.");
      }
      break;
  }

  const receipt =
    hasReceiptNumber && hasIssuedAt
      ? {
          receiptNumber: row.receiptNumber!,
          issuedAt: new Date(row.issuedAt!),
        }
      : null;

  const failure =
    hasFailureCode && hasFailureMessage
      ? {
          code: row.failureCode!,
          message: row.failureMessage!,
        }
      : null;

  return {
    id: row.id,
    zohoInvoiceId: row.zohoInvoiceId,
    status: row.status,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    receipt,
    failure,
    outcomeUnknownReason: row.outcomeUnknownReason,
  };
}

export function toDatabaseRecord(record: FiscalizationRecord) {
  return {
    id: record.id,
    zohoInvoiceId: record.zohoInvoiceId,
    status: record.status,
    receiptNumber: record.receipt?.receiptNumber ?? null,
    issuedAt: record.receipt?.issuedAt ?? null,
    failureCode: record.failure?.code ?? null,
    failureMessage: record.failure?.message ?? null,
    outcomeUnknownReason: record.outcomeUnknownReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
