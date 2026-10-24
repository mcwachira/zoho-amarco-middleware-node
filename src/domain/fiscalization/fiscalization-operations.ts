import type {
  FiscalizationFailure,
  FiscalizationRecord,
  FiscalReceipt,
} from "./fiscalization-record.js";

import {
  InvalidFiscalizationOperationError,
  InvalidFiscalizationTransitionError,
} from "./fiscalization-errors.js";

import { canTransition } from "./status-transitions.js";

/**
 * Updates a record's status only when the transition is permitted.
 *
 * Returning a new object avoids changing the original record in place.
 * The persistence layer will later be responsible for saving the update
 * safely and atomically in the database.
 */
function transitionTo(
  record: FiscalizationRecord,
  nextStatus: FiscalizationRecord["status"],
): FiscalizationRecord {
  if (!canTransition(record.status, nextStatus)) {
    throw new InvalidFiscalizationTransitionError(record.status, nextStatus);
  }

  return {
    ...record,
    status: nextStatus,
    updatedAt: new Date(),
  };
}

/**
 * Claims a Pending record for processing.
 *
 * This function enforces the domain rule, but it does not prevent two
 * separate workers from claiming the same database record concurrently.
 * We'll solve that later with an atomic database operation.
 */
export function startFiscalization(record: FiscalizationRecord): FiscalizationRecord {
  return transitionTo(record, "InProgress");
}

/**
 * Marks a fiscalization successful only when receipt details are available.
 *
 * Receipt details must come from a confirmed device result, not simply
 * from a successful HTTP response or an assumed outcome.
 */
export function completeFiscalization(
  record: FiscalizationRecord,
  receipt: FiscalReceipt,
): FiscalizationRecord {
  if (record.status !== "InProgress") {
    throw new InvalidFiscalizationOperationError(
      "Only an in-progress fiscalization can be completed.",
    );
  }

  if (receipt.receiptNumber.trim().length === 0) {
    throw new InvalidFiscalizationOperationError("Receipt number must not be empty.");
  }

  if (Number.isNaN(receipt.issuedAt.getTime())) {
    throw new InvalidFiscalizationOperationError("Receipt issue date must be valid.");
  }

  const updated = transitionTo(record, "Succeeded");

  return {
    ...updated,
    receipt: {
      receiptNumber: receipt.receiptNumber.trim(),
      issuedAt: new Date(receipt.issuedAt.getTime()),
    },
    failure: null,
    outcomeUnknownReason: null,
  };
}

/**
 * Records a failure only when we know the fiscal operation failed.
 *
 * A timeout alone is not necessarily a confirmed failure. If the device
 * may have issued a receipt, use markOutcomeUnknown instead.
 */
export function failFiscalization(
  record: FiscalizationRecord,
  failure: FiscalizationFailure,
): FiscalizationRecord {
  if (record.status !== "InProgress") {
    throw new InvalidFiscalizationOperationError(
      "Only an in-progress fiscalization can be marked as failed.",
    );
  }

  if (failure.code.trim().length === 0) {
    throw new InvalidFiscalizationOperationError("Failure code must not be empty.");
  }

  if (failure.message.trim().length === 0) {
    throw new InvalidFiscalizationOperationError("Failure message must not be empty.");
  }

  const updated = transitionTo(record, "Failed");

  return {
    ...updated,
    receipt: null,
    failure: {
      code: failure.code.trim(),
      message: failure.message.trim(),
    },
    outcomeUnknownReason: null,
  };
}

/**
 * Records an uncertain outcome without pretending the device failed.
 *
 * We deliberately do not provide a retry operation here. Reconciliation
 * must establish the device outcome before another fiscal command can run.
 */
export function markOutcomeUnknown(
  record: FiscalizationRecord,
  reason: string,
): FiscalizationRecord {
  const normalizedReason = reason.trim();

  if (normalizedReason.length === 0) {
    throw new InvalidFiscalizationOperationError(
      "An explanation is required for an unknown outcome.",
    );
  }

  const updated = transitionTo(record, "OutcomeUnknown");

  return {
    ...updated,
    receipt: null,
    failure: null,
    outcomeUnknownReason: normalizedReason,
  };
}
