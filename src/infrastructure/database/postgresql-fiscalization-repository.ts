import { randomUUID } from "node:crypto";
import type {
  FiscalizationHistoryQuery,
  FiscalizationRepository,
} from "../../application/fiscalization/fiscalization-repository.js";
import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
import {
  toDatabaseRecord,
  toDomainAttempt,
  toDomainRecord,
} from "./fiscalization-record-mapper.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import type { FiscalizationRecordWhereInput } from "../../generated/prisma/postgresql/models/FiscalizationRecord.js";
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

  async listHistory(query: FiscalizationHistoryQuery) {
    const where: FiscalizationRecordWhereInput = {
      ...((query.status ?? query.deviceOutcome)
        ? { status: query.status ?? query.deviceOutcome }
        : {}),
      ...(query.createdFrom || query.createdTo
        ? {
            createdAt: {
              ...(query.createdFrom ? { gte: query.createdFrom } : {}),
              ...(query.createdTo ? { lte: query.createdTo } : {}),
            },
          }
        : {}),
      ...(query.etimsStatus || query.correlationId
        ? {
            etimsReportingOperation: {
              is: {
                ...(query.etimsStatus ? { status: query.etimsStatus } : {}),
                ...(query.correlationId ? { correlationId: query.correlationId } : {}),
              },
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.fiscalizationRecord.findMany({
        where,
        include: {
          deviceAttempts: {
            orderBy: { attemptNumber: "asc" },
            select: { attemptNumber: true, outcome: true, errorCode: true },
          },
          etimsReportingOperation: { select: { status: true, correlationId: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.fiscalizationRecord.count({ where }),
    ]);
    const records = rows.map(toDomainRecord);
    const summaries = rows.map((row, index) => ({
      id: records[index]!.id,
      zohoInvoiceId: records[index]!.zohoInvoiceId,
      status: records[index]!.status,
      createdAt: records[index]!.createdAt,
      updatedAt: records[index]!.updatedAt,
      failureCode: row.failureCode,
      etimsStatus: row.etimsReportingOperation?.status ?? null,
      correlationId: row.etimsReportingOperation?.correlationId ?? null,
      deviceAttempts: row.deviceAttempts,
    }));
    return { records, total, summaries };
  }

  async findById(id: string): Promise<FiscalizationRecord | null> {
    const row = await this.prisma.fiscalizationRecord.findUnique({
      where: { id },
    });

    return row === null ? null : toDomainRecord(row);
  }

  async findByZohoInvoiceId(zohoInvoiceId: string): Promise<FiscalizationRecord | null> {
    const row = await this.prisma.fiscalizationRecord.findUnique({
      where: { zohoInvoiceId },
    });

    return row === null ? null : toDomainRecord(row);
  }

  async findAttemptsByRequestId(id: string) {
    const rows = await this.prisma.fiscalizationAttempt.findMany({
      where: { fiscalizationRequestId: id },
      orderBy: { attemptNumber: "asc" },
    });
    return rows.map(toDomainAttempt);
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
    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      // The claim and its durable attempt record commit together. The
      // transaction ends before any caller can contact the device.
      const result = await transaction.fiscalizationRecord.updateMany({
        where: { id, status: "Pending" },
        data: { status: "InProgress", updatedAt: now },
      });
      if (result.count !== 1) return null;
      const row = await transaction.fiscalizationRecord.findUnique({ where: { id } });
      if (!row) throw new Error("Claimed fiscalization request disappeared.");
      await transaction.fiscalizationAttempt.create({
        data: {
          id: randomUUID(),
          fiscalizationRequestId: id,
          attemptNumber: 1,
          startedAt: now,
        },
      });
      return toDomainRecord(row);
    });
  }

  async saveOutcome(record: FiscalizationRecord): Promise<boolean> {
    const databaseRecord = toDatabaseRecord(record);

    const now = new Date();
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.fiscalizationRecord.updateMany({
        where: { id: record.id, status: "InProgress" },
        data: {
          status: databaseRecord.status,
          receiptNumber: databaseRecord.receiptNumber,
          issuedAt: databaseRecord.issuedAt,
          failureCode: databaseRecord.failureCode,
          failureMessage: databaseRecord.failureMessage,
          outcomeUnknownReason: databaseRecord.outcomeUnknownReason,
          updatedAt: now,
        },
      });
      if (result.count !== 1) return false;
      const attemptResult = await transaction.fiscalizationAttempt.updateMany({
        where: { fiscalizationRequestId: record.id, completedAt: null },
        data: {
          completedAt: now,
          outcome:
            record.status === "Succeeded"
              ? "succeeded"
              : record.status === "Failed"
                ? "failed"
                : "outcome_unknown",
          receiptNumber: databaseRecord.receiptNumber,
          issuedAt: databaseRecord.issuedAt,
          errorCode: databaseRecord.failureCode,
          errorMessage: databaseRecord.failureMessage ?? databaseRecord.outcomeUnknownReason,
        },
      });
      if (attemptResult.count !== 1) {
        throw new Error("Claimed fiscalization attempt could not be completed.");
      }
      return true;
    });
  }

  async markStaleInProgressOutcomeUnknown(staleBefore: Date, reason: string): Promise<number> {
    // Validate the reason before modifying any database records.
    if (reason.trim().length === 0) {
      throw new Error("Recovery reason must not be empty.");
    }

    if (reason.length > 2000) {
      throw new Error("Recovery reason must not exceed 2000 characters.");
    }

    const stale = await this.prisma.fiscalizationRecord.findMany({
      where: { status: "InProgress", updatedAt: { lt: staleBefore } },
      select: { id: true },
    });
    let recovered = 0;
    const now = new Date();
    for (const candidate of stale) {
      const changed = await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.fiscalizationRecord.updateMany({
          where: { id: candidate.id, status: "InProgress", updatedAt: { lt: staleBefore } },
          data: {
            status: "OutcomeUnknown",
            receiptNumber: null,
            issuedAt: null,
            failureCode: null,
            failureMessage: null,
            outcomeUnknownReason: reason,
            updatedAt: now,
          },
        });
        if (result.count !== 1) return false;
        const attempt = await transaction.fiscalizationAttempt.updateMany({
          where: { fiscalizationRequestId: candidate.id, completedAt: null },
          data: {
            completedAt: now,
            outcome: "outcome_unknown",
            errorCode: "stale_operation_recovered",
            errorMessage: reason,
          },
        });
        if (attempt.count !== 1) {
          throw new Error("Stale fiscalization request has no active durable attempt.");
        }
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}
