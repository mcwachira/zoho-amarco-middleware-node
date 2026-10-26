import type { FiscalizationRepository } from "../../application/fiscalization/fiscalization-repository.js";
import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
import { toDatabaseRecord, toDomainRecord } from "./fiscalization-record-mapper.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import { DuplicateZohoInvoiceError } from "../../application/fiscalization/fiscalization-errors.js";

/**
 * Recognizes duplicate Zoho invoice errors reported by Prisma.
 *
 * Prisma's metadata format depends on the database adapter:
 * - Some errors expose the unique fields through `meta.target`.
 * - Prisma 7's PostgreSQL adapter exposes the constraint through
 *   `meta.driverAdapterError.cause.constraint.index`.
 *
 * We check the actual constraint name so that a duplicate primary key
 * is not incorrectly reported as a duplicate Zoho invoice.
 */
function isZohoInvoiceUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  if (error.code !== "P2002" || !("meta" in error)) {
    return false;
  }

  const meta = error.meta;

  if (typeof meta !== "object" || meta === null) {
    return false;
  }

  // Support Prisma error metadata that identifies the affected field.
  if ("target" in meta) {
    const target = meta.target;

    if (typeof target === "string") {
      return target.includes("zohoInvoiceId");
    }

    if (Array.isArray(target)) {
      return target.some(
        (field: unknown) => typeof field === "string" && field.includes("zohoInvoiceId"),
      );
    }

    return false;
  }

  // Support Prisma 7's PostgreSQL driver-adapter error structure.
  if (!("driverAdapterError" in meta)) {
    return false;
  }

  const driverAdapterError = meta.driverAdapterError;

  if (
    typeof driverAdapterError !== "object" ||
    driverAdapterError === null ||
    !("cause" in driverAdapterError)
  ) {
    return false;
  }

  const cause = driverAdapterError.cause;

  if (typeof cause !== "object" || cause === null || !("constraint" in cause)) {
    return false;
  }

  const constraint = cause.constraint;

  if (typeof constraint !== "object" || constraint === null || !("index" in constraint)) {
    return false;
  }

  return constraint.index === "FiscalizationRecord_zohoInvoiceId_key";
}
export class PostgresqlFiscalizationRepository implements FiscalizationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<FiscalizationRecord | null> {
    const row = await this.prisma.fiscalizationRecord.findUnique({
      where: { id },
    });

    return row === null ? null : toDomainRecord(row);
  }

  async create(record: FiscalizationRecord): Promise<void> {
    try {
      await this.prisma.fiscalizationRecord.create({
        data: toDatabaseRecord(record),
      });
    } catch (error: unknown) {
      if (isZohoInvoiceUniqueConstraintError(error)) {
        throw new DuplicateZohoInvoiceError(record.zohoInvoiceId);
      }

      throw error;
    }
  }

  async claimPending(id: string): Promise<FiscalizationRecord | null> {
    // Compare-and-set: only one worker can change Pending to InProgress.
    const result = await this.prisma.fiscalizationRecord.updateMany({
      where: {
        id,
        status: "Pending",
      },
      data: {
        status: "InProgress",
        updatedAt: new Date(),
      },
    });

    if (result.count !== 1) {
      return null;
    }

    // Read the record only after successfully claiming it.
    const row = await this.prisma.fiscalizationRecord.findUnique({
      where: { id },
    });

    if (row === null) {
      return null;
    }

    return toDomainRecord(row);
  }

  async saveOutcome(record: FiscalizationRecord): Promise<boolean> {
    const databaseRecord = toDatabaseRecord(record);

    // Persist the outcome only if this record is still InProgress.
    const result = await this.prisma.fiscalizationRecord.updateMany({
      where: {
        id: record.id,
        status: "InProgress",
      },
      data: {
        status: databaseRecord.status,
        receiptNumber: databaseRecord.receiptNumber,
        issuedAt: databaseRecord.issuedAt,
        failureCode: databaseRecord.failureCode,
        failureMessage: databaseRecord.failureMessage,
        outcomeUnknownReason: databaseRecord.outcomeUnknownReason,
        updatedAt: new Date(),
      },
    });

    return result.count === 1;
  }

  async markStaleInProgressOutcomeUnknown(staleBefore: Date, reason: string): Promise<number> {
    // Validate the reason before modifying any database records.
    if (reason.trim().length === 0) {
      throw new Error("Recovery reason must not be empty.");
    }

    if (reason.length > 2000) {
      throw new Error("Recovery reason must not exceed 2000 characters.");
    }

    // Atomically recover only records that are still InProgress
    // and whose last update occurred before the cutoff.
    const result = await this.prisma.fiscalizationRecord.updateMany({
      where: {
        status: "InProgress",
        updatedAt: {
          lt: staleBefore,
        },
      },
      data: {
        status: "OutcomeUnknown",
        receiptNumber: null,
        issuedAt: null,
        failureCode: null,
        failureMessage: null,
        outcomeUnknownReason: reason,
        updatedAt: new Date(),
      },
    });

    return result.count;
  }
}
