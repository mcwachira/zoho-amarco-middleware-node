import { describe, expect, it, vi } from "vitest";
import type { EtimsReconciliationWorkerOptions } from "../../src/application/fiscalization/etims-reconciliation-worker.js";
import { startConfiguredEtimsReconciliationWorker } from "../../src/application/fiscalization/etims-reconciliation-lifecycle.js";
import type { EtimsReportingReadiness } from "../../src/application/fiscalization/etims-reporting-service.js";

const ready = {
  enabled: true,
  selectedAdapterType: "vscu" as const,
  status: "ready" as const,
  blockers: [],
  capabilities: { supportsReconciliation: true, safeResubmissionAfterConfirmedNotFound: false },
};

function options(
  readiness: EtimsReportingReadiness = ready,
  enabled = true,
): EtimsReconciliationWorkerOptions {
  return {
    enabled,
    intervalMs: 60_000,
    batchSize: 10,
    maxAttempts: 5,
    staleAgeMs: 1_800_000,
    service: {
      getReadiness: () => readiness,
      listReconciliationCandidates: vi.fn(async () => []),
      reconcile: vi.fn(),
      recoverStaleInProgress: vi.fn(async () => 0),
      blockReconciliation: vi.fn(async () => {
        throw new Error("unused");
      }),
    },
    payloadResolver: { load: vi.fn(async () => ({ available: false as const })) },
  };
}

describe("configured eTIMS reconciliation lifecycle", () => {
  it("does not start unless explicitly enabled and reporting is ready", () => {
    expect(startConfiguredEtimsReconciliationWorker(options(ready, false)).health).toEqual({
      enabled: false,
      started: false,
      reason: "reconciliation_disabled",
    });
    const blocked = options({
      ...ready,
      enabled: false,
      status: "not_configured",
      blockers: ["reporting_disabled"],
    });
    expect(startConfiguredEtimsReconciliationWorker(blocked).health).toMatchObject({
      enabled: true,
      started: false,
      reason: "etims_reporting_disabled",
    });
  });

  it("starts the existing worker when capability is verified and shuts it down cleanly", async () => {
    const worker = startConfiguredEtimsReconciliationWorker(options());
    expect(worker.health).toEqual({ enabled: true, started: true, reason: null });
    await worker.stop();
  });

  it("keeps reconciliation unsupported adapters unavailable", () => {
    const workerOptions = options({
      ...ready,
      capabilities: { ...ready.capabilities, supportsReconciliation: false },
    });
    expect(startConfiguredEtimsReconciliationWorker(workerOptions).health).toMatchObject({
      enabled: true,
      started: false,
      reason: "reconciliation_capability_unavailable",
    });
  });
});
