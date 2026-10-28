import { describe, expect, it } from "vitest";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import type {
  ManualReviewCase,
  ManualReviewDecision,
  ManualReviewRepository,
  OpenManualReviewInput,
  RecordManualReviewDecisionInput,
} from "../../src/application/fiscalization/manual-review-repository.js";
import { ManualReviewService } from "../../src/application/fiscalization/manual-review-service.js";

class MemoryReviewRepository implements ManualReviewRepository {
  readonly cases = new Map<string, ManualReviewCase>();

  async openCase(input: OpenManualReviewInput): Promise<ManualReviewCase> {
    const existing = await this.getByRequestAndOperation(
      input.fiscalizationRequestId,
      input.operationId,
    );
    if (existing) return existing;
    const item: ManualReviewCase = {
      ...input,
      status: "open",
      resolvingOperatorSubject: null,
      resolvedAt: null,
      updatedAt: input.createdAt,
      decisions: [],
    };
    this.cases.set(item.id, item);
    return item;
  }

  async getCase(id: string) {
    return this.cases.get(id) ?? null;
  }

  async getByRequestAndOperation(requestId: string, operationId: string) {
    return (
      [...this.cases.values()].find(
        (item) => item.fiscalizationRequestId === requestId && item.operationId === operationId,
      ) ?? null
    );
  }

  async getByRequestId(requestId: string) {
    return (
      [...this.cases.values()].find((item) => item.fiscalizationRequestId === requestId) ?? null
    );
  }
  async listUnresolved(input: { limit: number; offset: number }) {
    return [...this.cases.values()]
      .filter((item) => item.status === "open")
      .slice(input.offset, input.offset + input.limit);
  }

  async recordDecision(input: RecordManualReviewDecisionInput) {
    const current = this.cases.get(input.caseId)!;
    const decision: ManualReviewDecision = { ...input, sequence: current.decisions.length + 1 };
    const updated: ManualReviewCase = {
      ...current,
      status: input.resolution === "operator_attested" ? "resolved" : "open",
      resolvingOperatorSubject:
        input.resolution === "operator_attested" ? input.operatorSubject : null,
      resolvedAt: input.resolution === "operator_attested" ? input.recordedAt : null,
      updatedAt: input.recordedAt,
      decisions: [...current.decisions, decision],
    };
    this.cases.set(updated.id, updated);
    return updated;
  }
}

describe("manual review", () => {
  it("persists an operator decision but keeps unsupported evidence unresolved", async () => {
    const reviews = new MemoryReviewRepository();
    const repository = {
      findById: async () => ({
        id: "request-1",
        zohoInvoiceId: "invoice-1",
        status: "OutcomeUnknown",
      }),
      findAttemptsByRequestId: async () => [{ id: "device-attempt-1" }],
    } as unknown as FiscalizationRepository;
    const service = new ManualReviewService(
      repository,
      reviews,
      undefined,
      undefined,
      () => new Date(0),
      () => "review-1",
    );
    const reviewCase = await service.open({
      requestId: "request-1",
      stage: "device",
      reason: "Communication was interrupted",
      operatorSubject: "operator-opening",
    });
    expect(reviewCase?.operationId).toBe("device-attempt-1");
    expect(reviewCase?.initiatingOperatorSubject).toBe("operator-opening");
    const decided = await service.decide({
      caseId: reviewCase!.id,
      operatorSubject: "operator-1",
      requestedOutcome: "confirmed_failure",
      reason: "Local output unavailable",
      evidenceReference: "bad evidence reference",
    });
    expect(decided?.status).toBe("open");
    expect(decided?.decisions[0]).toMatchObject({
      requestedOutcome: "confirmed_failure",
      resolution: "invalid_evidence",
      operatorSubject: "operator-1",
    });
    expect(decided?.relatedAttemptIds).toEqual(["device-attempt-1"]);
  });

  it("records supported evidence as a review resolution without replaying an external operation", async () => {
    let verificationCalls = 0;
    const reviews = new MemoryReviewRepository();
    const repository = {
      findById: async () => ({
        id: "request-1",
        zohoInvoiceId: "invoice-1",
        status: "OutcomeUnknown",
      }),
      findAttemptsByRequestId: async () => [{ id: "attempt-1" }],
    } as unknown as FiscalizationRepository;
    const service = new ManualReviewService(
      repository,
      reviews,
      undefined,
      {
        verify: async () => {
          verificationCalls += 1;
          return true;
        },
      },
      () => new Date(0),
      (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    );
    const reviewCase = await service.open({
      requestId: "request-1",
      stage: "device",
      reason: "Unknown result",
      operatorSubject: "operator-opening",
    });
    const result = await service.decide({
      caseId: reviewCase!.id,
      operatorSubject: "operator-1",
      requestedOutcome: "confirmed_success",
      reason: "Verified against external audit record",
      evidenceReference: "audit-record-17",
    });
    expect(result?.status).toBe("resolved");
    expect(result?.decisions[0]?.resolution).toBe("operator_attested");
    expect(result?.initiatingOperatorSubject).toBe("operator-opening");
    expect(result?.resolvingOperatorSubject).toBe("operator-1");
    expect(result?.resolvedAt).toEqual(new Date(0));
    expect(verificationCalls).toBe(1);
  });

  it("rejects ineligible outcomes and keeps simulated fiscal results separate", async () => {
    let fiscalStatus = "OutcomeUnknown";
    const reviews = new MemoryReviewRepository();
    const repository = {
      findById: async () => ({
        id: "request-2",
        zohoInvoiceId: "invoice-2",
        status: fiscalStatus,
        outcomeProvenance: "simulated",
      }),
      findAttemptsByRequestId: async () => [{ id: "attempt-2" }],
    } as unknown as FiscalizationRepository;
    const service = new ManualReviewService(repository, reviews);
    const reviewCase = await service.open({
      requestId: "request-2",
      stage: "device",
      reason: "uncertain simulated flow",
      operatorSubject: "operator-opening",
    });
    const result = await service.decide({
      caseId: reviewCase!.id,
      operatorSubject: "operator-1",
      requestedOutcome: "confirmed_success",
      reason: "No external proof",
    });
    expect(result?.status).toBe("open");
    expect(result?.decisions[0]?.resolution).toBe("invalid_evidence");
    fiscalStatus = "Succeeded";
    await expect(
      service.open({
        requestId: "request-2",
        stage: "device",
        reason: "not uncertain now",
        operatorSubject: "operator-opening",
      }),
    ).rejects.toThrow("persisted uncertain device operation");
    expect(fiscalStatus).toBe("Succeeded");
  });
});
