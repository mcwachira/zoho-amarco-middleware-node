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
} from "../../src/application/fiscalization/etims-reporting-adapter.js";
import { UnverifiedEtimsAdapter } from "../../src/application/fiscalization/etims-reporting-adapter.js";
import { KraEtimsReportingAdapter } from "../../src/integrations/etims/kra-etims-reporting-adapter.js";
import { KraOscuClient } from "../../src/integrations/etims/kra-oscu-client.js";
import { KraVscuClient } from "../../src/integrations/etims/kra-vscu-client.js";
import { syntheticMappedRequest } from "./kra-sales-mapping-fixture.js";
import type { EtimsReportingRepository } from "../../src/application/fiscalization/etims-reporting-repository.js";
import {
  EtimsReportingService,
  hashEtimsPayload,
} from "../../src/application/fiscalization/etims-reporting-service.js";
import {
  AesGcmEtimsPayloadProtection,
  EtimsSubmissionPayloadVault,
} from "../../src/application/fiscalization/etims-submission-payload-vault.js";
import type {
  EtimsSubmissionPayloadClaim,
  EtimsSubmissionPayloadRecord,
} from "../../src/application/fiscalization/etims-submission-payload.js";

class MemoryEtimsReportingRepository implements EtimsReportingRepository {
  private readonly operations = new Map<string, EtimsReportingOperation>();
  private readonly attempts = new Map<string, EtimsReportingAttempt[]>();
  private readonly payloads = new Map<string, EtimsSubmissionPayloadRecord>();

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

  async findReconciliationCandidates(
    limit: number,
  ): Promise<readonly EtimsReportingOperationDetails[]> {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          operation.reconciliationRequired &&
          (operation.status === "outcome_unknown" ||
            operation.status === "reconciliation_required") &&
          operation.adapterType !== null,
      )
      .sort(
        (left, right) =>
          left.updatedAt.getTime() - right.updatedAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(0, limit)
      .map((operation) => ({ operation, attempts: this.attempts.get(operation.id) ?? [] }));
  }

  async claimPending(claim: EtimsSubmissionPayloadClaim): Promise<EtimsReportingOperation | null> {
    const { operationId: id, now } = claim;
    const current = this.operations.get(id);
    if (!current || current.status !== "pending") return null;
    if (claim.payload.operationId !== id || claim.payload.payloadHash !== current.payloadHash) {
      throw new Error("eTIMS payload association mismatch");
    }
    const claimed = {
      ...current,
      status: "in_progress" as const,
      attemptNumber: current.attemptNumber + 1,
      updatedAt: now,
    };
    this.operations.set(id, claimed);
    this.payloads.set(`${id}:${claim.payload.submissionAttemptNumber}`, claim.payload);
    this.attempts.get(id)?.push({
      id: `${id}:${claimed.attemptNumber}`,
      operationId: id,
      attemptType: "submission",
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

  async findSubmissionPayload(
    id: string,
    attempt: number,
  ): Promise<EtimsSubmissionPayloadRecord | null> {
    return this.payloads.get(`${id}:${attempt}`) ?? null;
  }

  async claimReconciliation(
    id: string,
    expectedState: "outcome_unknown" | "reconciliation_required",
    now: Date,
  ): Promise<EtimsReportingOperation | null> {
    const current = this.operations.get(id);
    if (!current || current.status !== expectedState) return null;
    const claimed = {
      ...current,
      status: "reconciling" as const,
      reconciliationAttemptNumber: current.reconciliationAttemptNumber + 1,
      updatedAt: now,
    };
    this.operations.set(id, claimed);
    this.attempts.get(id)?.push({
      id: `${id}:reconciliation:${claimed.reconciliationAttemptNumber}`,
      operationId: id,
      attemptType: "reconciliation",
      attemptNumber: claimed.reconciliationAttemptNumber,
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
    const expectedState = attempt.attemptType === "submission" ? "in_progress" : "reconciling";
    if (current?.status !== expectedState) return false;
    this.operations.set(operation.id, operation);
    this.attempts.set(
      operation.id,
      (this.attempts.get(operation.id) ?? []).map((existing) =>
        existing.attemptType === attempt.attemptType &&
        existing.attemptNumber === attempt.attemptNumber
          ? attempt
          : existing,
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
          attempt.attemptType === "submission" && attempt.attemptNumber === operation.attemptNumber
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

  async markStaleReconciliationRequired(staleBefore: Date, now: Date): Promise<number> {
    let recovered = 0;
    for (const [id, operation] of this.operations) {
      if (operation.status !== "reconciling" || operation.updatedAt >= staleBefore) continue;
      this.operations.set(id, {
        ...operation,
        status: "reconciliation_required",
        errorCategory: "stale_reconciliation_recovered",
        errorMessage: "Provider reconciliation stopped before its outcome was recorded.",
        reconciliationRequired: true,
        updatedAt: now,
      });
      this.attempts.set(
        id,
        (this.attempts.get(id) ?? []).map((attempt) =>
          attempt.attemptType === "reconciliation" &&
          attempt.attemptNumber === operation.reconciliationAttemptNumber
            ? {
                ...attempt,
                completedAt: now,
                outcome: "outcome_unknown",
                errorCategory: "stale_reconciliation_recovered",
                errorMessage: "Provider reconciliation stopped before its outcome was recorded.",
              }
            : attempt,
        ),
      );
      recovered += 1;
    }
    return recovered;
  }
}

// Explicit test-only provider double; accepted references are synthetic and
// never represent a live eTIMS transaction or genuine fiscal receipt.
function createMockEtimsProvider(
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
    submit: vi.fn(async () => submitResult),
    reconcile: vi.fn(async () => reconcileResult),
  };
  return adapter;
}

function markAdapterReadyForLocalContractTest(
  adapter: EtimsReportingAdapter,
): EtimsReportingAdapter {
  // Test-only override of the immutable production readiness descriptor.
  Object.defineProperty(adapter, "status", {
    value: {
      ...adapter.status,
      contractVerified: true,
      operational: true,
      blockers: [],
    },
  });
  return {
    status: {
      ...adapter.status,
      contractVerified: true,
      operational: true,
      blockers: [],
    },
    validate: (request) => adapter.validate(request),
    submit: (request, signal) => adapter.submit(request, signal),
    reconcile: (request, signal) => adapter.reconcile(request, signal),
  };
}

function syntheticKraSalesRequest(mode: "oscu" | "vscu") {
  return syntheticMappedRequest(mode);
}

function createService(
  repository: MemoryEtimsReportingRepository,
  adapter: EtimsReportingAdapter,
  options: {
    readonly enabled?: boolean;
    readonly selectedAdapterType?: "vscu" | "oscu";
    readonly verifiedReceiptLifecycle?: boolean;
    readonly reconciliationTimeoutMs?: number;
  } = {},
) {
  let sequence = 0;
  const vault = new EtimsSubmissionPayloadVault(
    repository,
    new AesGcmEtimsPayloadProtection("a".repeat(64)),
  );
  return new EtimsReportingService(
    repository,
    [adapter],
    {
      enabled: options.enabled ?? true,
      selectedAdapterType: options.selectedAdapterType ?? "vscu",
      verifiedReceiptLifecycle: options.verifiedReceiptLifecycle ?? true,
      ...(options.reconciliationTimeoutMs !== undefined
        ? { reconciliationTimeoutMs: options.reconciliationTimeoutMs }
        : {}),
      now: () => new Date("2026-10-27T07:00:00.000Z"),
      createId: () => `test-id-${++sequence}`,
    },
    vault,
  );
}

const payload = { invoice: "synthetic-only" };

async function registerOperation(
  service: EtimsReportingService,
  operationPayload: unknown = payload,
) {
  return service.register({
    fiscalizationRequestId: "fiscalization-1",
    zohoInvoiceId: "zoho-invoice-1",
    payloadHash: hashEtimsPayload(operationPayload),
  });
}

describe("eTIMS adapter and reporting state machine", () => {
  it.each(["oscu", "vscu"] as const)(
    "routes the selected %s adapter through durable service claims using a mocked KRA transport",
    async (mode) => {
      const request = syntheticKraSalesRequest(mode);
      const response =
        mode === "oscu"
          ? {
              resultCd: "000",
              resultMsg: "synthetic response",
              resultDt: "20260401010101",
              data: {
                curRcptNo: 21,
                totRcptNo: 21,
                intrlData: "SYNTHETIC",
                rcptSign: "SYNTHETIC",
                sdcDateTime: "20260401010101",
              },
            }
          : {
              resultCd: "000",
              resultMsg: "synthetic response",
              resultDt: "20260401010101",
              data: {
                rcptNo: 21,
                intrlData: "SYNTHETIC",
                rcptSign: "SYNTHETIC",
                totRcptNo: 21,
                VSCURcptPbctDate: "20260401010101",
                sdcId: "SYNTHETIC-CU",
                mrcNo: "SYNTHETIC-MRC",
              },
            };
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
      const client =
        mode === "oscu"
          ? new KraOscuClient({ environment: "sandbox", fetchImpl })
          : new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl });
      const concreteAdapter = new KraEtimsReportingAdapter(client);
      expect(concreteAdapter.status).toMatchObject({ contractVerified: false, operational: false });

      // This readiness wrapper is test-only and represents a local fake contract harness.
      // The production server never applies it and the KRA client's fetch is mocked here.
      const adapter = markAdapterReadyForLocalContractTest(concreteAdapter);
      const repository = new MemoryEtimsReportingRepository();
      const service = createService(repository, adapter, { selectedAdapterType: mode });
      const operation = await registerOperation(service, request);
      const completed = await service.submit(operation.id, request);

      expect(completed.operation).toMatchObject({
        adapterType: mode,
        status: "accepted",
        providerReference: "21",
        attemptNumber: 1,
      });
      expect(completed.attempts).toMatchObject([
        { attemptType: "submission", outcome: "accepted" },
      ]);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(request);
      expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
        mode === "oscu" ? "etims-api-sbx.kra.go.ke" : "127.0.0.1:8088/trnsSales/saveSales",
      );
    },
  );

  it("keeps the concrete KRA adapter blocked in the real service and does not call its client", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new KraEtimsReportingAdapter(
      new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);
    const result = await service.submit(operation.id, request);

    expect(result.operation.status).toBe("blocked");
    expect(result.operation.errorMessage).toContain("submission_activation_closed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks invalid KRA payloads before claiming or transmitting a submission", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const repository = new MemoryEtimsReportingRepository();
    const service = createService(repository, adapter);
    const invalidRequest = { tin: "A123456789Z" };
    const operation = await registerOperation(service, invalidRequest);

    const result = await service.submit(operation.id, invalidRequest);

    expect(result.operation).toMatchObject({ status: "blocked", attemptNumber: 0 });
    expect(result.attempts).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists a client-confirmed pre-transmission failure as blocked, not uncertain", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const concrete = new KraEtimsReportingAdapter(
      new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
    );
    const testAdapter: EtimsReportingAdapter = {
      ...markAdapterReadyForLocalContractTest(concrete),
      // Simulate validation configuration changing between the service preflight and client call.
      validate: async () => [],
    };
    const service = createService(new MemoryEtimsReportingRepository(), testAdapter);
    const invalidRequest = { tin: "A123456789Z" };
    const operation = await registerOperation(service, invalidRequest);

    const result = await service.submit(operation.id, invalidRequest);

    expect(result.operation).toMatchObject({ status: "blocked", attemptNumber: 1 });
    expect(result.operation.errorCategory).toBe("invalid_kra_sales_request");
    expect(result.operation.reconciliationRequired).toBe(false);
    expect(result.attempts).toMatchObject([{ attemptType: "submission", outcome: null }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves a pre-cancelled submission unclaimed and safely pending", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);
    const controller = new AbortController();
    controller.abort();

    const result = await service.submit(operation.id, request, controller.signal);

    expect(result.operation).toMatchObject({ status: "pending", attemptNumber: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records cancellation after request transmission as uncertain without retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);
    const controller = new AbortController();

    const submission = service.submit(operation.id, request, controller.signal);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    const result = await submission;

    expect(result.operation).toMatchObject({
      status: "outcome_unknown",
      reconciliationRequired: true,
    });
    expect(result.operation.errorCategory).toBe("transport");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("records a timed-out KRA sales request as uncertain in the application state", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("timeout")), {
            once: true,
          });
        }),
    );
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", timeoutMs: 100, fetchImpl }),
      ),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);

    const result = await service.submit(operation.id, request);

    expect(result.operation).toMatchObject({
      status: "outcome_unknown",
      reconciliationRequired: true,
    });
    expect(result.operation.errorCategory).toBe("timeout");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("persists an uncertain KRA response and never resubmits it on a duplicate service call", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("synthetic socket loss"));
    const concrete = new KraEtimsReportingAdapter(
      new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
    );
    const adapter = markAdapterReadyForLocalContractTest(concrete);
    const service = createService(new MemoryEtimsReportingRepository(), adapter, {
      selectedAdapterType: "vscu",
    });
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);

    const first = await service.submit(operation.id, request);
    const duplicate = await service.submit(operation.id, request);

    expect(first.operation.status).toBe("outcome_unknown");
    expect(duplicate.operation.status).toBe("outcome_unknown");
    expect(first.operation.reconciliationRequired).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps malformed KRA success data uncertain and does not retry the sales write", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ resultCd: "000", resultMsg: "synthetic response", data: {} }),
      );
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);

    const first = await service.submit(operation.id, request);
    const retry = await service.submit(operation.id, request);

    expect(first.operation.status).toBe("outcome_unknown");
    expect(retry.operation.status).toBe("outcome_unknown");
    expect(first.operation.errorCategory).toBe("malformed_response");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("recovers to unknown when persisting a confirmed KRA result fails", async () => {
    class FailingOutcomeRepository extends MemoryEtimsReportingRepository {
      override async completeAttempt(): Promise<boolean> {
        throw new Error("synthetic persistence failure");
      }
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        resultCd: "000",
        resultMsg: "synthetic response",
        data: {
          rcptNo: 21,
          intrlData: "SYNTHETIC",
          rcptSign: "SYNTHETIC",
          totRcptNo: 21,
          VSCURcptPbctDate: "20260401010101",
          sdcId: "SYNTHETIC-CU",
          mrcNo: "SYNTHETIC-MRC",
        },
      }),
    );
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const repository = new FailingOutcomeRepository();
    const service = createService(repository, adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);

    await expect(service.submit(operation.id, request)).rejects.toThrow(
      "synthetic persistence failure",
    );
    expect((await service.getByFiscalizationRequestId("fiscalization-1"))?.operation.status).toBe(
      "in_progress",
    );
    expect(await service.recoverStaleInProgress(new Date("2026-10-27T07:01:00.000Z"))).toBe(1);
    expect((await service.getByFiscalizationRequestId("fiscalization-1"))?.operation.status).toBe(
      "outcome_unknown",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("persists explicit KRA rejection codes without exposing the provider message", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ resultCd: "994", resultMsg: "synthetic private provider message" }),
      );
    const adapter = markAdapterReadyForLocalContractTest(
      new KraEtimsReportingAdapter(
        new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
      ),
    );
    const service = createService(new MemoryEtimsReportingRepository(), adapter);
    const request = syntheticKraSalesRequest("vscu");
    const operation = await registerOperation(service, request);

    const result = await service.submit(operation.id, request);

    expect(result.operation).toMatchObject({ status: "rejected", errorCategory: "kra_result_994" });
    expect(result.operation.errorMessage).not.toContain("synthetic private provider message");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

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

  it("does not fall back to another operational model when the selected model is unavailable", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const vscu = createMockEtimsProvider();
    const service = createService(repository, vscu, { selectedAdapterType: "oscu" });
    const operation = await registerOperation(service);

    expect(operation).toMatchObject({ adapterType: "oscu", status: "blocked" });
    expect(service.getReadiness()).toMatchObject({
      selectedAdapterType: "oscu",
      blockers: ["selected_adapter_unavailable"],
    });
    expect((await service.submit(operation.id, payload)).operation.status).toBe("blocked");
    expect(vscu.submit).not.toHaveBeenCalled();
  });

  it("leaves reporting disabled by default even when an adapter name is selected", () => {
    const adapter = createMockEtimsProvider();
    const service = createService(new MemoryEtimsReportingRepository(), adapter, {
      enabled: false,
    });

    expect(service.getReadiness().status).toBe("not_configured");
    expect(service.getReadiness().blockers).toContain("reporting_disabled");
  });

  it("lists only bounded reconciliation candidates when the selected provider is verified", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider(
      {},
      {
        kind: "outcome_unknown",
        errorCategory: "timeout",
        safeMessage: "Provider response could not be confirmed.",
      },
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    await expect(service.listReconciliationCandidates(10)).resolves.toMatchObject([
      { operation: { id: operation.id, status: "outcome_unknown", reconciliationRequired: true } },
    ]);
    await expect(service.listReconciliationCandidates(101)).rejects.toThrow(
      "batch size must be between 1 and 100",
    );
  });

  it("does not query reconciliation candidates while reporting is disabled", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const lookup = vi.spyOn(repository, "findReconciliationCandidates");
    const service = createService(repository, createMockEtimsProvider(), { enabled: false });

    await expect(service.listReconciliationCandidates(10)).resolves.toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not submit when the verified receipt lifecycle is unavailable", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
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
    const adapter = createMockEtimsProvider();
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
    const rejectedAdapter = createMockEtimsProvider(
      {},
      {
        kind: "rejected",
        errorCategory: "apiToken=do-not-store",
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
    const unknownAdapter = createMockEtimsProvider(
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
    const adapter = createMockEtimsProvider(
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

  it("allows only one concurrent reconciliation claim", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider(
      {},
      {
        kind: "outcome_unknown",
        errorCategory: "timeout",
        safeMessage: "The provider result could not be confirmed.",
      },
    );
    let resolveReconciliation!: (result: EtimsAdapterReconciliationResult) => void;
    vi.mocked(adapter.reconcile).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReconciliation = resolve;
        }),
    );
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    const first = service.reconcile(operation.id, payload);
    const concurrent = service.reconcile(operation.id, payload);
    await vi.waitFor(() => expect(adapter.reconcile).toHaveBeenCalledOnce());
    const second = await concurrent;
    expect(second.operation.status).toBe("reconciling");
    expect(adapter.reconcile).toHaveBeenCalledOnce();

    resolveReconciliation({
      kind: "accepted",
      providerReference: "receipt-123",
      safeMetadataJson: null,
    });
    expect((await first).operation.status).toBe("accepted");
  });

  it("binds each permitted submission attempt to its own immutable encrypted payload", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    vi.mocked(adapter.submit)
      .mockResolvedValueOnce({
        kind: "outcome_unknown",
        errorCategory: "timeout",
        safeMessage: "Submission result is unknown.",
      })
      .mockResolvedValueOnce({
        kind: "accepted",
        providerReference: "ref-2",
        safeMetadataJson: null,
      });
    vi.mocked(adapter.reconcile).mockResolvedValue({ kind: "confirmed_not_found" });
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);

    await service.submit(operation.id, payload);
    await service.reconcile(operation.id, payload);
    const second = await service.submit(operation.id, payload);

    expect(second.operation).toMatchObject({ status: "accepted", attemptNumber: 2 });
    expect(adapter.submit).toHaveBeenCalledTimes(2);
    expect(await repository.findSubmissionPayload(operation.id, 1)).not.toBeNull();
    expect(await repository.findSubmissionPayload(operation.id, 2)).not.toBeNull();
  });

  it("persists a provider pending response as unresolved reconciliation work", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    vi.mocked(adapter.submit).mockResolvedValue({
      kind: "outcome_unknown",
      errorCategory: "timeout",
      safeMessage: "Submission result is unknown.",
    });
    vi.mocked(adapter.reconcile).mockResolvedValue({
      kind: "pending",
      safeMessage: "Provider is still processing the request.",
    });
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    const result = await service.reconcile(operation.id, payload);

    expect(result.operation).toMatchObject({
      status: "reconciliation_required",
      reconciliationRequired: true,
      errorCategory: "provider_pending",
    });
    expect(result.attempts.at(-1)).toMatchObject({
      attemptType: "reconciliation",
      outcome: "pending",
      completedAt: expect.any(Date),
    });
    expect(adapter.submit).toHaveBeenCalledOnce();
  });

  it("blocks an uncertain operation when immutable payload evidence is unavailable", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    vi.mocked(adapter.submit).mockResolvedValue({
      kind: "outcome_unknown",
      errorCategory: "timeout",
      safeMessage: "Submission result is unknown.",
    });
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    const result = await service.blockReconciliation(
      operation.id,
      "payload_missing",
      "The immutable submission payload required for reconciliation is unavailable.",
    );
    expect(result.operation).toMatchObject({
      status: "blocked",
      reconciliationRequired: false,
      errorCategory: "payload_missing",
    });
    expect(adapter.reconcile).not.toHaveBeenCalled();
    expect(adapter.submit).toHaveBeenCalledOnce();
  });

  it("passes cancellation to the adapter and persists an ambiguous result after a claimed lookup", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    vi.mocked(adapter.submit).mockResolvedValue({
      kind: "outcome_unknown",
      errorCategory: "timeout",
      safeMessage: "Submission result is unknown.",
    });
    const controller = new AbortController();
    vi.mocked(adapter.reconcile).mockImplementation(async (_request, signal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      controller.abort();
      throw new Error("provider lookup aborted after dispatch");
    });
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    const result = await service.reconcile(operation.id, payload, controller.signal);
    expect(result.operation).toMatchObject({
      status: "reconciliation_required",
      reconciliationRequired: true,
    });
    expect(result.attempts.at(-1)).toMatchObject({ outcome: "outcome_unknown" });
  });

  it("bounds a stalled reconciliation lookup and leaves the result uncertain", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    vi.mocked(adapter.submit).mockResolvedValue({
      kind: "outcome_unknown",
      errorCategory: "timeout",
      safeMessage: "Submission result is unknown.",
    });
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(adapter.reconcile).mockImplementation(
      (_request, signal) =>
        new Promise(() => {
          receivedSignal = signal;
        }),
    );
    const service = createService(repository, adapter, { reconciliationTimeoutMs: 5 });
    const operation = await registerOperation(service);
    await service.submit(operation.id, payload);

    const result = await service.reconcile(operation.id, payload);
    expect(result.operation).toMatchObject({
      status: "reconciliation_required",
      reconciliationRequired: true,
    });
    expect(result.attempts.at(-1)).toMatchObject({
      outcome: "outcome_unknown",
      completedAt: expect.any(Date),
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(adapter.submit).toHaveBeenCalledOnce();
  });

  it("fails closed before any provider request if durable encrypted payload storage is unavailable", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider();
    const service = new EtimsReportingService(repository, [adapter], {
      enabled: true,
      selectedAdapterType: "vscu",
      verifiedReceiptLifecycle: true,
    });
    const operation = await registerOperation(service);

    const result = await service.submit(operation.id, payload);
    expect(result.operation.status).toBe("blocked");
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(await repository.findSubmissionPayload(operation.id, 1)).toBeNull();
  });

  it("treats outcome_unknown to reconciling as a legal atomic claim transition", () => {
    expect(() => assertEtimsReportingTransition("outcome_unknown", "reconciling")).not.toThrow();
  });

  it("recovers a crashed reconciliation without resetting the uncertain result", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider(
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
    await repository.claimReconciliation(
      operation.id,
      "outcome_unknown",
      new Date("2026-10-27T06:00:00.000Z"),
    );

    expect(await service.recoverStaleInProgress(new Date("2026-10-27T06:30:00.000Z"))).toBe(1);
    expect((await service.getByFiscalizationRequestId("fiscalization-1"))?.operation).toMatchObject(
      {
        status: "reconciliation_required",
        reconciliationRequired: true,
      },
    );
    expect(adapter.submit).toHaveBeenCalledOnce();
    expect(adapter.reconcile).not.toHaveBeenCalled();
  });

  it("requires reconciliation when the selected model does not support lookup", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider(
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
    const adapter = createMockEtimsProvider();
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
    const adapter = createMockEtimsProvider();
    const service = createService(repository, adapter);
    const operation = await registerOperation(service);
    const details = await service.getByFiscalizationRequestId("fiscalization-1");
    expect(details).not.toBeNull();
    const vault = new EtimsSubmissionPayloadVault(
      repository,
      new AesGcmEtimsPayloadProtection("a".repeat(64)),
    );
    const claimAt = new Date("2026-10-27T06:00:00.000Z");
    await repository.claimPending({
      operationId: operation.id,
      now: claimAt,
      payload: vault.prepare(details!, payload, claimAt),
    });

    expect(await service.recoverStaleInProgress(new Date("2026-10-27T06:30:00.000Z"))).toBe(1);
    const recovered = await service.getByFiscalizationRequestId("fiscalization-1");
    expect(recovered?.operation.status).toBe("outcome_unknown");
    expect(recovered?.operation.reconciliationRequired).toBe(true);
    expect(adapter.submit).not.toHaveBeenCalled();
  });

  it("blocks payload changes and redacts sensitive provider diagnostics", async () => {
    const repository = new MemoryEtimsReportingRepository();
    const adapter = createMockEtimsProvider(
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
    expect(result.operation.errorCategory).not.toContain("do-not-store");
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
