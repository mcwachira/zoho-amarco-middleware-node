import { describe, expect, it, vi } from "vitest";
import {
  assertEtimsReportingTransition,
  type EtimsReportingAttempt,
  type EtimsReportingOperation,
  type EtimsReportingOperationDetails,
  type EtimsReportingState,
} from "../../src/domain/fiscalization/etims-reporting.js";
import type {
  EtimsAdapterReconciliationResult,
  EtimsAdapterStatus,
  EtimsAdapterSubmissionResult,
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "../../src/application/fiscalization/etims-reporting-adapter.js";
import { UnverifiedEtimsAdapter } from "../../src/application/fiscalization/etims-reporting-adapter.js";
import type { EtimsReportingRepository } from "../../src/application/fiscalization/etims-reporting-repository.js";
import {
  EtimsReportingService,
  hashEtimsPayload,
} from "../../src/application/fiscalization/etims-reporting-service.js";

class MemoryEtimsReportingRepository implements EtimsReportingRepository {
  private readonly operations = new Map<string, EtimsReportingOperation>();
  private readonly attempts = new Map<string, EtimsReportingAttempt[]>();

  async create(operation: EtimsReportingOperation): Promise<void> {
    if (
      [...this.operations.values()].some(
        (existing) => existing.fiscalizationRequestId === operation.fiscalizationRequestId,
      )
    ) {
      throw new Error("Duplicate fiscalization request.");
    }
    this.operations.set(operation.id, operation);
    this.attempts.set(operation.id, []);
  }

  async findById(id: string): Promise<EtimsReportingOperationDetails | null> {
    const operation = this.operations.get(id);
    return operation ? { operation, attempts: this.attempts.get(id) ?? [] } : null;
  }

  async findByFiscalizationRequestId(
    fiscalizationRequestId: string,
  ): Promise<EtimsReportingOperationDetails | null> {
    const operation = [...this.operations.values()].find(
      (candidate) => candidate.fiscalizationRequestId === fiscalizationRequestId,
    );
    return operation ? this.findById(operation.id) : null;
  }

  async claimPending(id: string, now: Date): Promise<EtimsReportingOperation | null> {
    const current = this.operations.get(id);
    if (!current || current.status !== "pending") return null;
    const claimed = {
      ...current,
      status: "in_progress" as const,
      attemptNumber: current.attemptNumber + 1,
      updatedAt: now,
    };
    this.operations.set(id, claimed);
    this.attempts.get(id)?.push({
      id: `${id}:${claimed.attemptNumber}`,
      operationId: id,
      attemptNumber: claimed.attemptNumber,
      startedAt: now,
      completedAt: null,
      outcome: null,
      providerReference: null,
      errorCategory: null,
      errorMessage: null,
    });
    return claimed;
  }

  async transition(
    id: string,
    expectedState: EtimsReportingState,
    operation: EtimsReportingOperation,
  ): Promise<boolean> {
    const current = this.operations.get(id);
    if (!current || current.status !== expectedState) return false;
    this.operations.set(id, operation);
    return true;
  }

  async completeAttempt(
    operation: EtimsReportingOperation,
    attempt: EtimsReportingAttempt,
  ): Promise<boolean> {
    const current = this.operations.get(operation.id);
    if (current?.status !== "in_progress") return false;
    this.operations.set(operation.id, operation);
    this.attempts.set(
      operation.id,
      (this.attempts.get(operation.id) ?? []).map((existing) =>
        existing.attemptNumber === attempt.attemptNumber ? attempt : existing,
      ),
    );
    return true;
  }

  async markStaleInProgressOutcomeUnknown(staleBefore: Date, now: Date): Promise<number> {
    let recovered = 0;
    for (const [id, operation] of this.operations) {
      if (operation.status !== "in_progress" || operation.updatedAt >= staleBefore) continue;
      this.operations.set(id, {
        ...operation,
        status: "outcome_unknown",
        errorCategory: "stale_operation_recovered",
        errorMessage: "The process stopped before the provider outcome was recorded.",
        reconciliationRequired: true,
        updatedAt: now,
      });
      this.attempts.set(
        id,
        (this.attempts.get(id) ?? []).map((attempt) =>
          attempt.attemptNumber === operation.attemptNumber
            ? {
                ...attempt,
                completedAt: now,
                outcome: "outcome_unknown",
                errorCategory: "stale_operation_recovered",
                errorMessage: "The process stopped before the provider outcome was recorded.",
              }
            : attempt,
        ),
      );
      recovered += 1;
    }
    return recovered;
  }
}

function createAdapter(
  overrides: Partial<EtimsAdapterStatus> = {},
  submitResult: EtimsAdapterSubmissionResult = {
    kind: "accepted",
    providerReference: "provider-ref-1",
    safeMetadataJson: null,
  },
  reconcileResult: EtimsAdapterReconciliationResult = { kind: "confirmed_not_found" },
) {
  const status: EtimsAdapterStatus = {
    adapterType: "vscu",
    configured: true,
    contractVerified: true,
    operational: true,
    configurationId: "test-config",
    blockers: [],
    capabilities: {
      supportsReconciliation: true,
      safeResubmissionAfterConfirmedNotFound: true,
    },
    ...overrides,
  };
  const adapter: EtimsReportingAdapter = {
    status,
    validate: vi.fn(async () => []),
    submit: vi.fn(async (_request: PreparedEtimsReportingRequest) => submitResult),
    reconcile: vi.fn(async (_request: PreparedEtimsReportingRequest) => reconcileResult),
  };
  return adapter;
}

function createService(
  repository: MemoryEtimsReportingRepository,
  adapter: EtimsReportingAdapter,
  options: {
    readonly enabled?: boolean;
    readonly selectedAdapterType?: "vscu" | "oscu";
    readonly verifiedReceiptLifecycle?: boolean;
  } = {},
) {
  let sequence = 0;
  return new EtimsReportingService(repository, [adapter], {
    enabled: options.enabled ?? true,
    selectedAdapterType: options.selectedAdapterType ?? "vscu",
    verifiedReceiptLifecycle: options.verifiedReceiptLifecycle ?? true,
    now: () => new Date("2026-10-27T07:00:00.000Z"),
    createId: () => `test-id-${++sequence}`,
  });
}

const payload = { invoice: "synthetic-only" };
const payloadHash = hashEtimsPayload(payload);

async function registerOperation(service: EtimsReportingService) {
  return service.register({
    fiscalizationRequestId: "fiscalization-1",
    zohoInvoiceId: "zoho-invoice-1",
    payloadHash,
  });
}

describe("eTIMS adapter and reporting state machine", () => {
  it("defaults missing configuration to non-operational and never falls back between models", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const vscu = new UnverifiedEtimsAdapter("vscu", true, true);
    const service = createService(repository, vscu, { selectedAdapterType: "vscu" });

    expect(service.getReadiness()).toMatchObject({
      selectedAdapterType: "vscu",
      status: "blocked",
      blockers: expect.arrayContaining(["provider_contract_unverified"]),
    });
    expect(vscu.status.operational).toBe(false);
    await registerOperation(service);
    const details = await service.getByFiscalizationRequestId("fiscalization-1");
    expect(details?.operation.adapterType).toBe("vscu");
    expect(details?.operation.status).toBe("blocked");
  });

  it("leaves reporting disabled by default even when an adapter name is selected", () => {
    const adapter = createAdapter();
    const service = createService(new MemoryEtimsReportingRepository(), adapter, {
      enabled: false,
    });

    expect(service.getReadiness().status).toBe("not_configured");
    expect(service.getReadiness().blockers).toContain("reporting_disabled");
  });

  it("does not submit when the verified receipt lifecycle is unavailable", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter();
    const service = createService(repository, adapter, { verifiedReceiptLifecycle: false });
    const operation = await registerOperation(service);

    expect(operation.status).toBe("blocked");
    expect(service.getReadiness().blockers).toContain("verified_receipt_lifecycle_unavailable");
    expect(await service.submit(operation.id, payload)).toMatchObject({
      operation: { status: "blocked" },
    });
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("atomically allows only one concurrent submitter to call the selected adapter", async () => {
    const repository = new MemoryEtimsReportingRepository();
    let resolveSubmission!: (result: EtimsAdapterSubmissionResult) => void;
    const adapter = createAdapter();
    vi.mocked(adapter.submit).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);

    const first = service.submit(operation.id, payload);
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledOnce());
    const second = await service.submit(operation.id, payload);
    expect(second.operation.status).toBe("in_progress");
    expect(adapter.submit).toHaveBeenCalledOnce();

    resolveSubmission({
      kind: "accepted",
      providerReference: "receipt-123",
      safeMetadataJson: null,
    });
    const completed = await first;
    expect(completed.operation.status).toBe("accepted");
    expect(completed.operation.providerReference).toBe("receipt-123");
    expect(completed.attempts).toHaveLength(1);
  });

  it("distinguishes confirmed rejection from an ambiguous provider outcome", async () => {
    const rejectedRepository = new MemoryEtimsReportingRepository();
    const rejectedAdapter = createAdapter(
      {},
      {
        kind: "rejected",
        errorCategory: "provider_rejected",
        safeMessage: "The provider rejected the request.",
        providerReference: null,
        safeMetadataJson: null,
      },
    );
    const rejectedService = createService(rejectedRepository, rejectedAdapter);
    const rejectedOperation = await registerOperation(rejectedService);
    const rejected = await rejectedService.submit(rejectedOperation.id, payload);
    expect(rejected.operation.status).toBe("rejected");
    expect(rejected.operation.reconciliationRequired).toBe(false);

    const unknownRepository = new MemoryEtimsReportingRepository();
    const unknownAdapter = createAdapter(
      {},
      {
        kind: "outcome_unknown",
        errorCategory: "transport_ambiguous",
        safeMessage: "The provider result could not be confirmed.",
      },
    );
    const unknownService = createService(unknownRepository, unknownAdapter);
    const unknownOperation = await registerOperation(unknownService);
    const unknown = await unknownService.submit(unknownOperation.id, payload);
    expect(unknown.operation.status).toBe("outcome_unknown");
    expect(unknown.operation.reconciliationRequired).toBe(true);
  });

  it("does not blindly retry unknown results and only returns to pending after verified reconciliation", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter(
      {},
      {
        kind: "outcome_unknown",
        errorCategory: "timeout",
        safeMessage: "The provider result could not be confirmed.",
      },
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);

    await service.submit(operation.id, payload);
    await service.submit(operation.id, payload);
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect((await service.getByFiscalizationRequestId("fiscalization-1"))?.operation.status).toBe(
      "outcome_unknown",
    );

    const reconciled = await service.reconcile(operation.id, payload);
    expect(reconciled.operation.status).toBe("pending");
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.reconcile).toHaveBeenCalledOnce();
    expect(reconciled.operation.adapterType).toBe("vscu");
  });

  it("requires reconciliation when the selected model does not support lookup", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter(
      {
        capabilities: {
          supportsReconciliation: false,
          safeResubmissionAfterConfirmedNotFound: false,
        },
      },
      {
        kind: "outcome_unknown",
        errorCategory: "timeout",
        safeMessage: "Unknown provider outcome.",
      },
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);

    await service.submit(operation.id, payload);
    const result = await service.reconcile(operation.id, payload);
    expect(result.operation.status).toBe("reconciliation_required");
    expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledOnce();
  });

  it("preserves confirmed terminal results against later submit attempts", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter();
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    const accepted = await service.submit(operation.id, payload);
    const repeated = await service.submit(operation.id, payload);

    expect(repeated.operation.status).toBe("accepted");
    expect(repeated.operation.providerReference).toBe("provider-ref-1");
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(accepted.attempts).toHaveLength(1);
  });

  it("recovers a crashed in-progress submission to unknown without resending", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter();
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await repository.claimPending(operation.id, new Date("2026-10-27T06:00:00.000Z"));

    expect(await service.recoverStaleInProgress(new Date("2026-10-27T06:30:00.000Z"))).toBe(1);
    const recovered = await service.getByFiscalizationRequestId("fiscalization-1");
    expect(recovered?.operation.status).toBe("outcome_unknown");
    expect(recovered?.operation.reconciliationRequired).toBe(true);
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("blocks payload changes and redacts sensitive provider diagnostics", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createAdapter(
      {},
      {
        kind: "rejected",
        errorCategory: "provider_rejected",
        safeMessage: "Authorization: Bearer super-secret-token",
        providerReference: "authorization: secret-token",
        safeMetadataJson: '{"apiToken":"do-not-store","state":"rejected"}',
      },
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);

    await expect(service.submit(operation.id, { invoice: "changed" })).rejects.toThrow(
      "does not match the immutable payload hash",
    );
    expect(adapter.submit).not.toHaveBeenCalled();

    const result = await service.submit(operation.id, payload);
    expect(result.operation.errorMessage).not.toContain("super-secret-token");
    expect(result.operation.providerReference).toBeNull();
    expect(result.operation.providerMetadataJson).not.toContain("do-not-store");
    expect(result.operation.providerMetadataJson).toContain("rejected");
  });

  it("rejects illegal transitions, including overwriting an accepted or rejected result", () => {
    expect(() => assertEtimsReportingTransition("accepted", "pending")).toThrow(
      "Invalid eTIMS reporting transition",
    );
    expect(() => assertEtimsReportingTransition("rejected", "accepted")).toThrow(
      "Invalid eTIMS reporting transition",
    );
    expect(() => assertEtimsReportingTransition("outcome_unknown", "pending")).toThrow(
      "Invalid eTIMS reporting transition",
    );
  });
});
