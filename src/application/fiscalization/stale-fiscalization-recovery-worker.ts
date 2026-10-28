import { logger } from "../../observability/logger.js";
import type { RecoverStaleFiscalizationsService } from "./recover-stale-fiscalizations.js";
import {
  operationalMetrics,
  safelyBeginJobMetric,
  type OperationalMetrics,
} from "../../observability/operational-metrics.js";

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_STALE_AGE_MS = 30 * 60 * 1000;

interface StaleFiscalizationRecoveryWorkerOptions {
  service: RecoverStaleFiscalizationsService;
  intervalMs?: number;
  staleAgeMs?: number;
  now?: () => Date;
  metrics?: OperationalMetrics;
}

function assertPositiveFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
}

/**
 * Periodically marks sufficiently old InProgress records OutcomeUnknown.
 *
 * This worker never calls the fiscal device and never retries a receipt.
 * It does not run immediately on startup. Each run completes before the
 * next interval is scheduled, preventing overlapping recovery jobs.
 */
export function startStaleFiscalizationRecoveryWorker({
  service,
  intervalMs = DEFAULT_INTERVAL_MS,
  staleAgeMs = DEFAULT_STALE_AGE_MS,
  now = () => new Date(),
  metrics = operationalMetrics,
}: StaleFiscalizationRecoveryWorkerOptions): {
  stop: () => Promise<void>;
} {
  assertPositiveFiniteNumber(intervalMs, "Recovery interval");
  assertPositiveFiniteNumber(staleAgeMs, "Stale age");

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNextRun = (): void => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      inFlight = runRecovery();
    }, intervalMs);

    // The timer alone must not keep Node.js alive.
    timer.unref();
  };

  const runRecovery = async (): Promise<void> => {
    const finishMetric = safelyBeginJobMetric(metrics, "stale_recovery");
    try {
      const recoveryTime = now();
      const staleBefore = new Date(recoveryTime.getTime() - staleAgeMs);

      const recoveredCount = await service.execute({
        staleBefore,
        reason:
          "Automatically marked OutcomeUnknown because the fiscalization request exceeded the configured stale age. Reconcile the device and KRA records before any retry.",
      });

      if (recoveredCount > 0) {
        logger.warn(
          { recoveredCount, staleBefore },
          "Stale fiscalization requests marked OutcomeUnknown; reconciliation is required",
        );
      }
      finishMetric(false);
    } catch {
      finishMetric(true);
      logger.error("Stale fiscalization recovery run failed");
    } finally {
      inFlight = undefined;
      scheduleNextRun();
    }
  };

  scheduleNextRun();

  return {
    async stop(): Promise<void> {
      stopped = true;

      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }

      // Let an already-running database operation finish before shutdown.
      await inFlight;
    },
  };
}
