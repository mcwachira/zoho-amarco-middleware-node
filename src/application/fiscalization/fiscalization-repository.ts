import type {
  FiscalizationAttempt,
  FiscalizationRecord,
} from "../../domain/fiscalization/fiscalization-record.js";

export interface FiscalizationHistoryQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: string;
  readonly deviceOutcome?: string;
  readonly createdFrom?: Date;
  readonly createdTo?: Date;
  readonly etimsStatus?: string;
  readonly correlationId?: string;
}

export interface FiscalizationHistoryPage {
  readonly records: readonly FiscalizationRecord[];
  readonly total: number;
  readonly summaries?: readonly FiscalizationHistorySummary[];
}

export interface FiscalizationHistorySummary {
  readonly id: string;
  readonly zohoInvoiceId: string;
  readonly status: FiscalizationRecord["status"];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly failureCode: string | null;
  readonly etimsStatus: string | null;
  readonly correlationId: string | null;
  readonly deviceAttempts: readonly {
    readonly attemptNumber: number;
    readonly outcome: string | null;
    readonly errorCode: string | null;
  }[];
}

/**
 * Describes how the application interacts with stored fiscalization records.
 *
 * This is an interface, not a database implementation. Later, Prisma will
 * implement it for PostgreSQL without changing the service.
 */
export interface FiscalizationRepository {
  listHistory?(query: FiscalizationHistoryQuery): Promise<FiscalizationHistoryPage>;
  /** Returns persisted, sanitized device operation history when supported. */
  findAttemptsByRequestId?(id: string): Promise<readonly FiscalizationAttempt[]>;
  /**
   * Finds a fiscalization record by our internal ID.
   *
   * Returns null when no record exists.
   */
  findById(id: string): Promise<FiscalizationRecord | null>;

  /**
   * Finds the existing record for a Zoho invoice, if one has been registered.
   */
  findByZohoInvoiceId(zohoInvoiceId: string): Promise<FiscalizationRecord | null>;

  /**
   * Creates a new Pending record.
   *
   * The database implementation must enforce uniqueness for the Zoho invoice
   * ID so the same invoice cannot accidentally be registered twice.
   */
  create(record: FiscalizationRecord): Promise<void>;

  /**
   * Atomically claims a Pending record for processing.
   *
   * The database must perform the Pending -> InProgress transition
   * conditionally, in one atomic operation. It must not first read the record
   * and then update it in a separate, unprotected step.
   *
   * Returns the claimed InProgress record, or null if the record does not
   * exist or another worker has already claimed it.
   */
  claimPending(id: string): Promise<FiscalizationRecord | null>;

  /**
   * Persists a terminal outcome: Succeeded, Failed, or OutcomeUnknown.
   *
   * The implementation must update only a record that is still InProgress.
   * Returns false if the record could not be updated under that condition.
   */
  saveOutcome(record: FiscalizationRecord): Promise<boolean>;

  /**
   * Marks stale InProgress records as OutcomeUnknown.
   *
   * The database implementation must atomically update only records that:
   * - are still InProgress; and
   * - have an updatedAt timestamp earlier than staleBefore.
   *
   * This operation must never reset a record to Pending or call the device.
   * Returns the number of records moved to OutcomeUnknown.
   */
  markStaleInProgressOutcomeUnknown(staleBefore: Date, reason: string): Promise<number>;
}
