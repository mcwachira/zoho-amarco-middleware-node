import type { ManualReviewRepository } from "../../application/fiscalization/manual-review-repository.js";
import { ManualReviewConflictError } from "../../application/fiscalization/manual-review-service.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import { toManualReviewCase } from "./manual-review-mapper.js";

const includeDecisions = { decisions: { orderBy: { sequence: "asc" as const } } };

export class PostgresqlManualReviewRepository implements ManualReviewRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async openCase(input: Parameters<ManualReviewRepository["openCase"]>[0]) {
    try {
      const row = await this.prisma.manualReviewCase.create({
        data: {
          id: input.id,
          fiscalizationRequestId: input.fiscalizationRequestId,
          operationId: input.operationId,
          relatedAttemptIdsJson: JSON.stringify(input.relatedAttemptIds),
          observedState: input.observedState,
          reason: input.reason,
          initiatingOperatorSubject: input.initiatingOperatorSubject,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        },
        include: includeDecisions,
      });
      return toManualReviewCase(row);
    } catch (error: unknown) {
      const existing = await this.getByRequestAndOperation(
        input.fiscalizationRequestId,
        input.operationId,
      );
      if (existing) return existing;
      throw error;
    }
  }

  async getCase(id: string) {
    const row = await this.prisma.manualReviewCase.findUnique({
      where: { id },
      include: includeDecisions,
    });
    return row ? toManualReviewCase(row) : null;
  }

  async getByRequestAndOperation(fiscalizationRequestId: string, operationId: string) {
    const row = await this.prisma.manualReviewCase.findUnique({
      where: { fiscalizationRequestId_operationId: { fiscalizationRequestId, operationId } },
      include: includeDecisions,
    });
    return row ? toManualReviewCase(row) : null;
  }

  async getByRequestId(fiscalizationRequestId: string) {
    const row = await this.prisma.manualReviewCase.findFirst({
      where: { fiscalizationRequestId },
      orderBy: { createdAt: "desc" },
      include: includeDecisions,
    });
    return row ? toManualReviewCase(row) : null;
  }

  async listUnresolved(input: { limit: number; offset: number }) {
    const rows = await this.prisma.manualReviewCase.findMany({
      where: { status: "open" },
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: input.limit,
      skip: input.offset,
      include: includeDecisions,
    });
    return rows.map(toManualReviewCase);
  }

  async recordDecision(input: Parameters<ManualReviewRepository["recordDecision"]>[0]) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.manualReviewCase.findUnique({
        where: { id: input.caseId },
        include: includeDecisions,
      });
      const latest = current?.decisions.at(-1);
      if (
        current &&
        latest &&
        latest.operatorSubject === input.operatorSubject &&
        latest.requestedOutcome === input.requestedOutcome &&
        latest.resolution === input.resolution &&
        latest.reason === input.reason &&
        latest.evidenceReference === input.evidenceReference
      )
        return toManualReviewCase(current);
      if (!current || current.status !== "open") {
        throw new ManualReviewConflictError(
          "Review case is missing, resolved, or concurrently changed.",
        );
      }
      const sequence = current.decisionSequence + 1;
      const updated = await tx.manualReviewCase.updateMany({
        where: { id: current.id, status: "open", decisionSequence: current.decisionSequence },
        data: {
          decisionSequence: sequence,
          status: input.resolution === "operator_attested" ? "resolved" : "open",
          resolvingOperatorSubject:
            input.resolution === "operator_attested" ? input.operatorSubject : null,
          resolvedAt: input.resolution === "operator_attested" ? input.recordedAt : null,
          updatedAt: input.recordedAt,
        },
      });
      if (updated.count !== 1)
        throw new ManualReviewConflictError("A concurrent review decision was recorded.");
      await tx.manualReviewDecision.create({ data: { ...input, sequence } });
      const result = await tx.manualReviewCase.findUnique({
        where: { id: current.id },
        include: includeDecisions,
      });
      if (!result) throw new Error("Manual review case disappeared while recording its decision.");
      return toManualReviewCase(result);
    });
  }
}
