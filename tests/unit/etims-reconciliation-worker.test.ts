import { describe, expect, it, vi } from "vitest";
import type { EtimsReportingOperationDetails } from "../../src/domain/fiscalization/etims-reporting.js";
import {
  runEtimsReconciliationBatch,
  startEtimsReconciliationWorker,
  type EtimsReconciliationPayloadResolver,
  type EtimsReconciliationWorkerOptions,
} from "../../src/application/fiscalization/etims-reconciliation-worker.js";
import { EtimsSubmissionPayloadIntegrityError } from "../../src/application/fiscalization/etims-submission-payload.js";

const now = new Date("2026-10-27T08:00:00.000Z");

function candidate(
  overrides: Partial<EtimsReportingOperationDetails["operation"]> = {},
  attempts: EtimsReportingOperationDetails["attempts"] = [],
): EtimsReportingOperationDetails {
  return {
    operation: {
      id: "operation-1",
      fiscalizationRequestId: "request-1",
      zohoInvoiceId: "invoice-1",
      adapterType: "vscu",
      adapterConfigurationId: "test-config",
      correlationId: "correlation-1",
      status: "reconciliation_required",
      payloadHash: "a".repeat(64),
      attemptNumber: 1,
      reconciliationAttemptNumber: 0,
      providerReference: null,
      providerMetadataJson: null,
      errorCategory: "reconciliation_unknown",
      errorMessage: "Provider result is uncertain.",
      reconciliationRequired: true,
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 60_000),
      ...overrides,
    },
    attempts,
  };
}

function makeOptions(
  initial: readonly EtimsReportingOperationDetails[] = [candidate()],
  result: "accepted" | "pending" | "outcome_unknown" = "accepted",
  enabled = true,
) {
  let current = [...initial];
  const service = {
    getReadiness: vi.fn(() => ({
      enabled,
      selectedAdapterType: "vscu" as const,
      status: enabled ? ("ready" as const) : ("not_configured" as const),
      blockers: enabled ? [] : ["reporting_disabled"],
      capabilities: {
        supportsReconciliation: enabled,
        safeResubmissionAfterConfirmedNotFound: false,
      },
    })),
    listReconciliationCandidates: vi.fn(async () => current),
    reconcile: vi.fn(async (_id: string, _payload: unknown, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("aborted");
      const previous = current[0]!;
      const attemptNumber = previous.operation.reconciliationAttemptNumber + 1;
      const status = result === "accepted" ? "accepted" : "reconciliation_required";
      const attemptOutcome = result;
      const updated: EtimsReportingOperationDetails = {
        operation: {
          ...previous.operation,
          status,
          reconciliationAttemptNumber: attemptNumber,
          reconciliationRequired: result !== "accepted",
          updatedAt: now,
        },
        attempts: [
          ...previous.attempts,
          {
            id: `attempt-${attemptNumber}`,
            operationId: previous.operation.id,
            attemptType: "reconciliation",
            attemptNumber,
            startedAt: now,
            completedAt: now,
            outcome: attemptOutcome,
            providerReference: null,
            errorCategory: result === "accepted" ? null : "not_confirmed",
            errorMessage: result === "accepted" ? null : "Provider status is unresolved.",
          },
        ],
      };
      current = [updated];
      return updated;
    }),
    recoverStaleInProgress: vi.fn(async () => 0),
    blockReconciliation: vi.fn(async () => candidate()),
  };
  const payloadResolver: EtimsReconciliationPayloadResolver = {
    load: vi.fn(async () => ({ available: true as const, payload: { original: "immutable" } })),
  };
  const options: EtimsReconciliationWorkerOptions = {
    service: service as unknown as EtimsReconciliationWorkerOptions["service"],
    payloadResolver,
    enabled,
    intervalMs: 60_000,
    batchSize: 10,
    maxAttempts: 5,
    staleAgeMs: 1_800_000,
    retryBaseDelayMs: 30_000,
    retryMaxDelayMs: 300_000,
    now: () => now,
  };
  return { options, service, payloadResolver };
}

describe("scheduled eTIMS reconciliation", () => {
  it("reconciles due uncertain records through the existing service and records completion", async () => {
    const { options, service, payloadResolver } = makeOptions();
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(service.recoverStaleInProgress).toHaveBeenCalledWith(
      new Date(now.getTime() - options.staleAgeMs),
    );
    expect(service.listReconciliationCandidates).toHaveBeenCalledWith(options.batchSize);
    expect(payloadResolver.load).toHaveBeenCalledOnce();
    expect(service.reconcile).toHaveBeenCalledWith(
      "operation-1",
      { original: "immutable" },
      expect.any(AbortSignal),
    );
    expect(result).toMatchObject({ candidates: 1, attempted: 1, pending: 0, failed: 0 });
  });

  it("keeps a provider pending result unresolved and records it as an attempt", async () => {
    const { options, service } = makeOptions([candidate()], "pending");
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(result).toMatchObject({ attempted: 1, pending: 1 });
    await expect(service.reconcile.mock.results[0]?.value).resolves.toMatchObject({
      operation: { status: "reconciliation_required", reconciliationRequired: true },
      attempts: [expect.objectContaining({ outcome: "pending", completedAt: now })],
    });
  });

  it("does not call storage, payload resolution, or providers when reporting is disabled", async () => {
    const { options, service, payloadResolver } = makeOptions([candidate()], "accepted", false);
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(result.candidates).toBe(0);
    expect(service.recoverStaleInProgress).not.toHaveBeenCalled();
    expect(service.listReconciliationCandidates).not.toHaveBeenCalled();
    expect(payloadResolver.load).not.toHaveBeenCalled();
    expect(service.reconcile).not.toHaveBeenCalled();
  });

  it("uses bounded exponential backoff and stops at the configured attempt limit", async () => {
    const oldAttempt = {
      id: "reconciliation-1",
      operationId: "operation-1",
      attemptType: "reconciliation" as const,
      attemptNumber: 1,
      startedAt: new Date(now.getTime() - 20_000),
      completedAt: new Date(now.getTime() - 10_000),
      outcome: "pending" as const,
      providerReference: null,
      errorCategory: null,
      errorMessage: null,
    };
    const backoff = makeOptions([candidate({ reconciliationAttemptNumber: 1 }, [oldAttempt])]);
    const notDue = await runEtimsReconciliationBatch(backoff.options, new AbortController().signal);
    expect(notDue.attempted).toBe(0);
    expect(backoff.service.reconcile).not.toHaveBeenCalled();

    const exhausted = makeOptions([
      candidate({ reconciliationAttemptNumber: 5 }, [
        { ...oldAttempt, attemptNumber: 5, completedAt: new Date(now.getTime() - 60_000) },
      ]),
    ]);
    const stopped = await runEtimsReconciliationBatch(
      exhausted.options,
      new AbortController().signal,
    );
    expect(stopped.exhausted).toBe(1);
    expect(exhausted.service.reconcile).not.toHaveBeenCalled();
  });

  it("leaves a candidate blocked when its immutable payload is unavailable", async () => {
    const { options, service, payloadResolver } = makeOptions();
    vi.mocked(payloadResolver.load).mockResolvedValue({ available: false });
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(result.unavailablePayload).toBe(1);
    expect(service.reconcile).not.toHaveBeenCalled();
    expect(service.blockReconciliation).toHaveBeenCalledWith(
      "operation-1",
      "payload_missing",
      "The immutable submission payload required for reconciliation is unavailable.",
    );
  });

  it("blocks corrupt immutable payloads without making a provider call", async () => {
    const { options, service, payloadResolver } = makeOptions();
    vi.mocked(payloadResolver.load).mockRejectedValue(new EtimsSubmissionPayloadIntegrityError());
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);
    expect(result.unavailablePayload).toBe(1);
    expect(service.blockReconciliation).toHaveBeenCalledWith(
      "operation-1",
      "payload_integrity_failed",
      "The stored submission payload is missing or failed integrity validation.",
    );
    expect(service.reconcile).not.toHaveBeenCalled();
  });

  it("observes cancellation before reconciliation and passes the signal to an active call", async () => {
    const { options, service, payloadResolver } = makeOptions();
    const controller = new AbortController();
    vi.mocked(payloadResolver.load).mockImplementation(async (_details, signal) => {
      controller.abort();
      expect(signal.aborted).toBe(true);
      return { available: true, payload: { original: "immutable" } };
    });
    const result = await runEtimsReconciliationBatch(options, controller.signal);

    expect(result.cancelled).toBe(true);
    expect(service.reconcile).not.toHaveBeenCalled();
  });

  it("recovers abandoned claims after restart before loading candidates", async () => {
    const { options, service } = makeOptions([]);
    await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(service.recoverStaleInProgress).toHaveBeenCalledOnce();
    expect(service.recoverStaleInProgress.mock.invocationCallOrder[0]).toBeLessThan(
      service.listReconciliationCandidates.mock.invocationCallOrder[0]!,
    );
  });

  it("surfaces a reconciliation service failure without asserting a provider outcome", async () => {
    const { options, service } = makeOptions();
    vi.mocked(service.reconcile).mockRejectedValueOnce(new Error("database unavailable"));
    const result = await runEtimsReconciliationBatch(options, new AbortController().signal);

    expect(result.failed).toBe(1);
    expect(result.attempted).toBe(0);
  });

  it("does not start duplicate in-process schedulers and stops cleanly", async () => {
    const { options } = makeOptions([]);
    const worker = startEtimsReconciliationWorker(options);
    expect(() => startEtimsReconciliationWorker(options)).toThrow(
      "eTIMS reconciliation worker is already running",
    );
    await worker.stop();
    const restarted = startEtimsReconciliationWorker(options);
    await restarted.stop();
  });

  it("aborts an active payload lookup and waits for it during graceful shutdown", async () => {
    vi.useFakeTimers({ now });
    try {
      const { options, service, payloadResolver } = makeOptions();
      let lookupStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        lookupStarted = resolve;
      });
      vi.mocked(payloadResolver.load).mockImplementation(
        (_details, signal) =>
          new Promise((_, reject) => {
            lookupStarted();
            signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          }),
      );
      const worker = startEtimsReconciliationWorker(options);
      await vi.advanceTimersByTimeAsync(options.intervalMs);
      await started;
      await worker.stop();

      expect(service.reconcile).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets concurrent workers list the same record but only one claimed lookup completes", async () => {
    const { options, service } = makeOptions();
    const original = candidate();
    const activeAttempt = {
      id: "attempt-1",
      operationId: "operation-1",
      attemptType: "reconciliation" as const,
      attemptNumber: 1,
      startedAt: now,
      completedAt: null,
      outcome: null,
      providerReference: null,
      errorCategory: null,
      errorMessage: null,
    };
    const active: EtimsReportingOperationDetails = {
      operation: {
        ...original.operation,
        status: "reconciling",
        reconciliationAttemptNumber: 1,
      },
      attempts: [activeAttempt],
    };
    const completed: EtimsReportingOperationDetails = {
      operation: { ...active.operation, status: "accepted", reconciliationRequired: false },
      attempts: [{ ...activeAttempt, completedAt: now, outcome: "accepted" }],
    };
    let claimed = false;
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    service.listReconciliationCandidates.mockImplementation(async () => [original]);
    service.reconcile.mockImplementation(async () => {
      if (claimed) return active;
      claimed = true;
      await claimGate;
      return completed;
    });

    const firstRun = runEtimsReconciliationBatch(options, new AbortController().signal);
    await vi.waitFor(() => expect(service.reconcile).toHaveBeenCalledOnce());
    const secondRun = await runEtimsReconciliationBatch(options, new AbortController().signal);
    releaseClaim();
    const firstResult = await firstRun;

    expect(secondRun.attempted).toBe(0);
    expect(firstResult.attempted).toBe(1);
    expect(service.reconcile).toHaveBeenCalledTimes(2);
  });
});
