import type { EtimsReconciliationWorkerOptions } from "./etims-reconciliation-worker.js";
import { startEtimsReconciliationWorker } from "./etims-reconciliation-worker.js";

export interface EtimsReconciliationLifecycleHealth {
  readonly enabled: boolean;
  readonly started: boolean;
  readonly reason: string | null;
}

export function startConfiguredEtimsReconciliationWorker(
  options: EtimsReconciliationWorkerOptions,
): {
  readonly health: EtimsReconciliationLifecycleHealth;
  readonly stop: () => Promise<void>;
} {
  if (!options.enabled) {
    return {
      health: { enabled: false, started: false, reason: "reconciliation_disabled" },
      stop: async () => undefined,
    };
  }
  const readiness = options.service.getReadiness();
  if (!readiness.enabled) {
    return {
      health: { enabled: true, started: false, reason: "etims_reporting_disabled" },
      stop: async () => undefined,
    };
  }
  if (readiness.status !== "ready") {
    return {
      health: {
        enabled: true,
        started: false,
        reason: readiness.blockers[0] ?? "provider_unavailable",
      },
      stop: async () => undefined,
    };
  }
  if (!readiness.capabilities.supportsReconciliation) {
    return {
      health: { enabled: true, started: false, reason: "reconciliation_capability_unavailable" },
      stop: async () => undefined,
    };
  }
  return {
    health: { enabled: true, started: true, reason: null },
    stop: startEtimsReconciliationWorker(options).stop,
  };
}
