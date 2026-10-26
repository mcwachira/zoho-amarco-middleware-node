import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";

/**
 * Describes how the application interacts with stored fiscalization records.
 *
 * This is an interface, not a database implementation. Later, Prisma will
 * implement it for PostgreSQL or SQL Server without changing the service.
 */
export interface FiscalizationRepository {
  /**
   * Finds a fiscalization record by our internal ID.
   *
   * Returns null when no record exists.
   */
  findById(id: string): Promise<FiscalizationRecord | null>;

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
