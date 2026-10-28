import { randomUUID } from "node:crypto";
import type { EtimsReportingRepository } from "../../application/fiscalization/etims-reporting-repository.js";
import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingState,
} from "../../domain/fiscalization/etims-reporting.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import { assertEtimsReportingTransition } from "../../domain/fiscalization/etims-reporting.js";
import { mapEtimsAttempt, mapEtimsDetails, mapEtimsOperation } from "./etims-reporting-mapper.js";
import type {
  EtimsSubmissionPayloadClaim,
  EtimsSubmissionPayloadRecord,
} from "../../application/fiscalization/etims-submission-payload.js";

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
      orderBy: [{ startedAt: "asc" }, { attemptType: "asc" }, { attemptNumber: "asc" }],
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
      orderBy: [{ startedAt: "asc" }, { attemptType: "asc" }, { attemptNumber: "asc" }],
    });
    return mapEtimsDetails(operation, attempts);
  }

  async findReconciliationCandidates(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("eTIMS reconciliation candidate limit must be between 1 and 100.");
    }
    const operations = await this.prisma.etimsReportingOperation.findMany({
      where: {
        status: { in: ["outcome_unknown", "reconciliation_required"] },
        reconciliationRequired: true,
        adapterType: { not: null },
      },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: limit,
    });
    return Promise.all(
      operations.map(async (operation) => {
        const attempts = await this.prisma.etimsReportingAttempt.findMany({
          where: { operationId: operation.id },
          orderBy: [{ startedAt: "asc" }, { attemptType: "asc" }, { attemptNumber: "asc" }],
        });
        return {
          operation: mapEtimsOperation(operation),
          attempts: attempts.map(mapEtimsAttempt),
        };
      }),
    );
  }

  async claimPending(claim: EtimsSubmissionPayloadClaim): Promise<EtimsReportingOperation | null> {
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.etimsReportingOperation.updateMany({
        where: { id: claim.operationId, status: "pending" },
        data: { status: "in_progress", attemptNumber: { increment: 1 }, updatedAt: claim.now },
      });
      if (changed.count !== 1) return null;
      const row = await transaction.etimsReportingOperation.findUnique({
        where: { id: claim.operationId },
      });
      if (!row) throw new Error("Claimed eTIMS reporting operation disappeared.");
      const operation = mapEtimsOperation(row);
      await transaction.etimsReportingAttempt.create({
        data: {
          id: randomUUID(),
          operationId: operation.id,
          attemptType: "submission",
          attemptNumber: operation.attemptNumber,
          startedAt: claim.now,
        },
      });
      if (
        claim.payload.operationId !== operation.id ||
        claim.payload.fiscalizationRequestId !== operation.fiscalizationRequestId ||
        claim.payload.submissionAttemptNumber !== operation.attemptNumber ||
        claim.payload.payloadHash !== operation.payloadHash
      ) {
        throw new Error("eTIMS submission payload does not match the claimed operation.");
      }
      await transaction.etimsSubmissionPayload.create({ data: claim.payload });
      return operation;
    });
  }

  async findSubmissionPayload(
    operationId: string,
    submissionAttemptNumber: number,
  ): Promise<EtimsSubmissionPayloadRecord | null> {
    const row = await this.prisma.etimsSubmissionPayload.findUnique({
      where: { operationId_submissionAttemptNumber: { operationId, submissionAttemptNumber } },
    });
    if (!row) return null;
    if (row.submissionAttemptType !== "submission") {
      throw new Error("Stored eTIMS payload is associated with an unsupported attempt type.");
    }
    return { ...row, submissionAttemptType: "submission" };
  }

  async claimReconciliation(
    id: string,
    expectedState: "outcome_unknown" | "reconciliation_required",
    now: Date,
  ): Promise<EtimsReportingOperation | null> {
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.etimsReportingOperation.updateMany({
        where: { id, status: expectedState },
        data: {
          status: "reconciling",
          reconciliationAttemptNumber: { increment: 1 },
          updatedAt: now,
        },
      });
      if (changed.count !== 1) return null;
      const row = await transaction.etimsReportingOperation.findUnique({ where: { id } });
      if (!row) throw new Error("Claimed eTIMS reconciliation operation disappeared.");
      const operation = mapEtimsOperation(row);
      await transaction.etimsReportingAttempt.create({
        data: {
          id: randomUUID(),
          operationId: operation.id,
          attemptType: "reconciliation",
          attemptNumber: operation.reconciliationAttemptNumber,
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
    const currentState = attempt.attemptType === "submission" ? "in_progress" : "reconciling";
    assertEtimsReportingTransition(currentState, operation.status);
    return this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.etimsReportingOperation.updateMany({
        where: {
          id: operation.id,
          status: currentState,
          ...(attempt.attemptType === "submission"
            ? { attemptNumber: operation.attemptNumber }
            : { reconciliationAttemptNumber: operation.reconciliationAttemptNumber }),
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
        where: {
          operationId: attempt.operationId,
          attemptType: attempt.attemptType,
          attemptNumber: attempt.attemptNumber,
        },
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
        const attempt = await transaction.etimsReportingAttempt.updateMany({
          where: {
            operationId: candidate.id,
            attemptType: "submission",
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
        if (attempt.count !== 1) {
          throw new Error("Stale eTIMS submission has no active durable attempt.");
        }
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }

  async markStaleReconciliationRequired(staleBefore: Date, now: Date): Promise<number> {
    const stale = await this.prisma.etimsReportingOperation.findMany({
      where: { status: "reconciling", updatedAt: { lt: staleBefore } },
      select: { id: true, reconciliationAttemptNumber: true },
    });
    let recovered = 0;
    for (const candidate of stale) {
      const changed = await this.prisma.$transaction(async (transaction) => {
        const updated = await transaction.etimsReportingOperation.updateMany({
          where: { id: candidate.id, status: "reconciling", updatedAt: { lt: staleBefore } },
          data: {
            status: "reconciliation_required",
            reconciliationRequired: true,
            errorCategory: "stale_reconciliation_recovered",
            errorMessage: "Provider reconciliation stopped before its outcome was recorded.",
            updatedAt: now,
          },
        });
        if (updated.count !== 1) return false;
        const attempt = await transaction.etimsReportingAttempt.updateMany({
          where: {
            operationId: candidate.id,
            attemptType: "reconciliation",
            attemptNumber: candidate.reconciliationAttemptNumber,
            completedAt: null,
          },
          data: {
            completedAt: now,
            outcome: "outcome_unknown",
            errorCategory: "stale_reconciliation_recovered",
            errorMessage: "Provider reconciliation stopped before its outcome was recorded.",
          },
        });
        if (attempt.count !== 1) {
          throw new Error("Stale eTIMS reconciliation has no active durable attempt.");
        }
        return true;
      });
      if (changed) recovered += 1;
    }
    return recovered;
  }
}
