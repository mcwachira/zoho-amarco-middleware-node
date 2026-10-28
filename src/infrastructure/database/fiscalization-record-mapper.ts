import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
import type { FiscalizationAttempt } from "../../domain/fiscalization/fiscalization-record.js";
import {
  FiscalizationSnapshotError,
  parseFiscalizationSnapshot,
} from "../../application/fiscalization/fiscalization-snapshot.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";

import {
  fiscalizationStatuses,
  type FiscalizationStatus,
} from "../../domain/fiscalization/status.js";

export interface FiscalizationRecordRow {
  id: string;
  zohoInvoiceId: string;
  status: string;
  snapshotVersion: number | null;
  snapshotJson: string | null;
  receiptNumber: string | null;
  issuedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  outcomeUnknownReason: string | null;
  outcomeProvenance: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FiscalizationAttemptRow {
  id: string;
  fiscalizationRequestId: string;
  attemptNumber: number;
  startedAt: Date;
  completedAt: Date | null;
  outcome: string | null;
  receiptNumber: string | null;
  issuedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

const attemptOutcomes = ["succeeded", "failed", "outcome_unknown"] as const;

export function toDomainAttempt(row: FiscalizationAttemptRow): FiscalizationAttempt {
  if (row.attemptNumber < 1 || !Number.isSafeInteger(row.attemptNumber)) {
    throw new Error("Database fiscalization attempt has an invalid attempt number.");
  }
  if (
    row.outcome !== null &&
    !attemptOutcomes.includes(row.outcome as (typeof attemptOutcomes)[number])
  ) {
    throw new Error(`Database contains an invalid fiscalization attempt outcome: ${row.outcome}.`);
  }
  const dates = [
    row.startedAt,
    ...(row.completedAt ? [row.completedAt] : []),
    ...(row.issuedAt ? [row.issuedAt] : []),
  ];
  if (dates.some((date) => Number.isNaN(date.getTime()))) {
    throw new Error("Database fiscalization attempt contains an invalid date.");
  }
  return { ...row, outcome: row.outcome as FiscalizationAttempt["outcome"] };
}

function isFiscalizationStatus(value: string): value is FiscalizationStatus {
  return (fiscalizationStatuses as readonly string[]).includes(value);
}

export function toDomainRecord(row: FiscalizationRecordRow): FiscalizationRecord {
  if (!isFiscalizationStatus(row.status)) {
    throw new Error(`Invalid fiscalization status in database: "${row.status}".`);
  }
  if (
    row.outcomeProvenance !== null &&
    row.outcomeProvenance !== "simulated" &&
    row.outcomeProvenance !== "authoritative" &&
    row.outcomeProvenance !== "unverified"
  ) {
    throw new Error("Database record contains an invalid fiscalization outcome provenance.");
  }

  // Reject invalid dates before constructing the domain record.
  const dates = [row.createdAt, row.updatedAt];

  if (row.issuedAt !== null) {
    dates.push(row.issuedAt);
  }

  if (dates.some((date) => Number.isNaN(date.getTime()))) {
    throw new Error("Database record contains an invalid date.");
  }

  if ((row.snapshotJson === null) !== (row.snapshotVersion === null)) {
    throw new FiscalizationSnapshotError("Database record contains incomplete snapshot metadata.");
  }

  let snapshot: FiscalizationSnapshot | null = null;
  if (row.snapshotJson !== null) {
    if (row.snapshotJson.length > 1_000_000) {
      throw new FiscalizationSnapshotError("Database record exceeds the supported snapshot size.");
    }

    let value: unknown;
    try {
      value = JSON.parse(row.snapshotJson);
    } catch {
      throw new FiscalizationSnapshotError("Database record contains malformed snapshot JSON.");
    }

    snapshot = parseFiscalizationSnapshot(value, row.snapshotVersion);
    if (snapshot.invoice.zohoInvoiceId !== row.zohoInvoiceId) {
      throw new FiscalizationSnapshotError(
        "Database snapshot invoice identity does not match the record.",
      );
    }
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
    snapshot,
    snapshotVersion: row.snapshotVersion,
    status: row.status,
    outcomeProvenance: (row.outcomeProvenance ?? null) as Exclude<
      FiscalizationRecord["outcomeProvenance"],
      undefined
    >,
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
    snapshotVersion: record.snapshot?.schemaVersion ?? null,
    snapshotJson: record.snapshot === null ? null : JSON.stringify(record.snapshot),
    status: record.status,
    outcomeProvenance: record.outcomeProvenance ?? null,
    receiptNumber: record.receipt?.receiptNumber ?? null,
    issuedAt: record.receipt?.issuedAt ?? null,
    failureCode: record.failure?.code ?? null,
    failureMessage: record.failure?.message ?? null,
    outcomeUnknownReason: record.outcomeUnknownReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
