import type { FiscalizationStatus } from "./status.js";
import type { FiscalizationSnapshot } from "./fiscalization-snapshot.js";

/**
 * Details that identify a successfully issued fiscal receipt.
 *
 * We will refine these fields after reviewing the Tremol protocol
 * and confirming the actual response returned by ZFPLabServer.
 */
export interface FiscalReceipt {
  /** The receipt number confirmed by the fiscal device. */
  readonly receiptNumber: string;

  /** The date and time the receipt was issued, if confirmed. */
  readonly issuedAt: Date;
}

/**
 * Safe diagnostic information about a failed fiscalization attempt.
 *
 * Do not store credentials, customer secrets, or unrestricted raw device
 * responses in this object.
 */
export interface FiscalizationFailure {
  /** A stable, machine-readable error code. */
  readonly code: string;

  /** A sanitized description suitable for application diagnostics. */
  readonly message: string;
}

/**
 * Represents one fiscalization attempt for a Zoho Books invoice.
 *
 * This is a domain model, not a database model. It does not depend on
 * Prisma, Express, SQL Server, PostgreSQL, or the Tremol device SDK.
 */
export interface FiscalizationRecord {
  /** Our internal, unique identifier for this record. */
  readonly id: string;

  /** The stable invoice identifier received from Zoho Books. */
  readonly zohoInvoiceId: string;

  /** Immutable source inputs captured before the request becomes Pending. */
  readonly snapshot: FiscalizationSnapshot | null;
  readonly snapshotVersion: number | null;

  /** The current state of this fiscalization attempt. */
  readonly status: FiscalizationStatus;

  /** When our system created this record. */
  readonly createdAt: Date;

  /** When this record was last updated. */
  readonly updatedAt: Date;

  /** Receipt details, populated only after success is confirmed. */
  readonly receipt: FiscalReceipt | null;

  /** Failure details, populated when a failure is established. */
  readonly failure: FiscalizationFailure | null;

  readonly outcomeUnknownReason: string | null;
}

/**
 * Input needed to create a new fiscalization record.
 *
 * The caller supplies the ID so ID generation can later be handled by
 * the application layer without coupling the domain to a specific library.
 */
export interface CreateFiscalizationRecordInput {
  readonly id: string;
  readonly zohoInvoiceId: string;
  readonly snapshot?: FiscalizationSnapshot | null;
}

/**
 * Creates a new fiscalization record in its initial Pending state.
 *
 * The optional `now` argument makes the function deterministic in tests:
 * tests can provide a fixed date instead of depending on the real clock.
 */
export function createFiscalizationRecord(
  input: CreateFiscalizationRecordInput,
  now: Date = new Date(),
): FiscalizationRecord {
  // Trim whitespace so values such as "   " cannot be accepted as IDs.
  const id = input.id.trim();
  const zohoInvoiceId = input.zohoInvoiceId.trim();

  if (id.length === 0) {
    throw new Error("Fiscalization record ID must not be empty.");
  }

  if (zohoInvoiceId.length === 0) {
    throw new Error("Zoho invoice ID must not be empty.");
  }

  // Create one timestamp and use it consistently for both fields.
  // Reject invalid dates before they can enter the domain model.
  if (Number.isNaN(now.getTime())) {
    throw new Error("Fiscalization timestamp must be a valid date.");
  }

  // Copy the date so the record does not share a mutable Date object
  // with the caller. Both timestamps represent the same instant.
  const timestamp = new Date(now.getTime());

  return {
    id,
    zohoInvoiceId,
    snapshot: input.snapshot ?? null,
    snapshotVersion: input.snapshot?.schemaVersion ?? null,
    outcomeUnknownReason: null,
    status: "Pending",
    createdAt: timestamp,
    updatedAt: new Date(timestamp.getTime()),
    receipt: null,
    failure: null,
  };
}
