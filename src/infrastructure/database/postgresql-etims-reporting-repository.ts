import { randomUUID } from "node:crypto";
import type { EtimsReportingRepository } from "../../application/fiscalization/etims-reporting-repository.js";
import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingState,
} from "../../domain/fiscalization/etims-reporting.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import { assertEtimsReportingTransition } from "../../domain/fiscalization/etims-reporting.js";
import { mapEtimsDetails, mapEtimsOperation } from "./etims-reporting-mapper.js";

export class PostgresqlEtimsReportingRepository implements EtimsReportingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(operation: EtimsReportingOperation): Promise<void> {
    await this.prisma.etimsReportingOperation.create({ data: operation });
  }

  async findById(id: string) {
    const operation = await this.prisma.etimsReportingOperation.findUnique({ where: { id } });
    if (!operation) return null;
    const attempts = await this.prisma.etimsReportingAttempt.findMany({
      where: { operationId: id },
      orderBy: { attemptNumber: "asc" },
    });
    return mapEtimsDetails(operation, attempts);
  }

  async findByFiscalizationRequestId(fiscalizationRequestId: string) {
    const operation = await this.prisma.etimsReportingOperation.findUnique({
      where: { fiscalizationRequestId },
    });
    if (!operation) return null;
    const attempts = await this.prisma.etimsReportingAttempt.findMany({
      where: { operationId: operation.id },
      orderBy: { attemptNumber: "asc" },
    });
    return mapEtimsDetails(operation, attempts);
  }

  async claimPending(id: string, now: Date): Promise<EtimsReportingOperation | null> {
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.etimsReportingOperation.updateMany({
        where: { id, status: "pending" },
        data: { status: "in_progress", attemptNumber: { increment: 1 }, updatedAt: now },
      });
      if (changed.count !== 1) return null;
      const row = await transaction.etimsReportingOperation.findUnique({ where: { id } });
      if (!row) throw new Error("Claimed eTIMS reporting operation disappeared.");
      const operation = mapEtimsOperation(row);
      await transaction.etimsReportingAttempt.create({
        data: {
          id: randomUUID(),
          operationId: operation.id,
          attemptNumber: operation.attemptNumber,
          startedAt: now,
        },
      });
      return operation;
    });
  }

  async transition(
    id: string,
    expectedState: EtimsReportingState,
    operation: EtimsReportingOperation,
  ): Promise<boolean> {
    assertEtimsReportingTransition(expectedState, operation.status);
    const changed = await this.prisma.etimsReportingOperation.updateMany({
      where: { id, status: expectedState },
      data: {
        status: operation.status,
        providerReference: operation.providerReference,
        providerMetadataJson: operation.providerMetadataJson,
        errorCategory: operation.errorCategory,
        errorMessage: operation.errorMessage,
        reconciliationRequired: operation.reconciliationRequired,
        updatedAt: operation.updatedAt,
      },
    });
    return changed.count === 1;
  }

  async completeAttempt(
    operation: EtimsReportingOperation,
    attempt: EtimsReportingAttempt,
  ): Promise<boolean> {
    assertEtimsReportingTransition("in_progress", operation.status);
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.etimsReportingOperation.updateMany({
        where: {
          id: operation.id,
          status: "in_progress",
          attemptNumber: operation.attemptNumber,
        },
        data: {
          status: operation.status,
          providerReference: operation.providerReference,
          providerMetadataJson: operation.providerMetadataJson,
          errorCategory: operation.errorCategory,
          errorMessage: operation.errorMessage,
          reconciliationRequired: operation.reconciliationRequired,
          updatedAt: operation.updatedAt,
        },
      });
      if (changed.count !== 1) return false;
      const attemptResult = await transaction.etimsReportingAttempt.updateMany({
        where: { operationId: attempt.operationId, attemptNumber: attempt.attemptNumber },
        data: {
          completedAt: attempt.completedAt,
          outcome: attempt.outcome,
          providerReference: attempt.providerReference,
          errorCategory: attempt.errorCategory,
          errorMessage: attempt.errorMessage,
        },
      });
      if (attemptResult.count !== 1) {
        throw new Error("Claimed eTIMS reporting attempt could not be completed.");
      }
      return true;
    });
  }

  async markStaleInProgressOutcomeUnknown(staleBefore: Date, now: Date): Promise<number> {
    const stale = await this.prisma.etimsReportingOperation.findMany({
      where: { status: "in_progress", updatedAt: { lt: staleBefore } },
      select: { id: true, attemptNumber: true },
    });
    let recovered = 0;
    for (const candidate of stale) {
      const changed = await this.prisma.$transaction(async (transaction) => {
        const result = await transaction.etimsReportingOperation.updateMany({
          where: {
            id: candidate.id,
            status: "in_progress",
            updatedAt: { lt: staleBefore },
          },
          data: {
            status: "outcome_unknown",
            reconciliationRequired: true,
            errorCategory: "stale_operation_recovered",
            errorMessage: "The process stopped before the provider outcome was recorded.",
            updatedAt: now,
          },
        });
        if (result.count !== 1) return false;
        await transaction.etimsReportingAttempt.updateMany({
          where: {
            operationId: candidate.id,
            attemptNumber: candidate.attemptNumber,
            completedAt: null,
          },
          data: {
            completedAt: now,
            outcome: "outcome_unknown",
            errorCategory: "stale_operation_recovered",
            errorMessage: "The process stopped before the provider outcome was recorded.",
          },
        });
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}
