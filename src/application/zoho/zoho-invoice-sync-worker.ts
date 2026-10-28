import { logger } from "../../observability/logger.js";
import type { ZohoInvoiceSynchronizationService } from "./zoho-invoice-synchronization.js";
import {
  operationalMetrics,
  safelyBeginJobMetric,
  type OperationalMetrics,
} from "../../observability/operational-metrics.js";

let workerStarted = false;

export function startZohoInvoiceSyncWorker(options: {
  readonly service: ZohoInvoiceSynchronizationService;
  readonly intervalMs: number;
  readonly metrics?: OperationalMetrics;
}): { readonly stop: () => Promise<void> } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 60_000) {
    throw new Error("Zoho synchronization interval must be at least one minute.");
  }
  if (workerStarted) {
    throw new Error("Zoho invoice synchronization worker is already running.");
  }
  workerStarted = true;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let activeAbortController: AbortController | undefined;

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      activeAbortController = new AbortController();
      inFlight = run(activeAbortController);
    }, options.intervalMs);
    timer.unref();
  };

  const run = async (abortController: AbortController): Promise<void> => {
    const finishMetric = safelyBeginJobMetric(options.metrics ?? operationalMetrics, "zoho_sync");
    try {
      const result = await options.service.execute(abortController.signal);
      finishMetric(result.state === "failed" || result.state === "partial");
      if (result.state === "busy") {
        logger.info(
          "Scheduled Zoho synchronization skipped because another instance holds the lease",
        );
      } else {
        logger.info(
          {
            runId: result.run.id,
            state: result.state,
            discovered: result.run.discovered,
            imported: result.run.imported,
            duplicatesSkipped: result.run.duplicatesSkipped,
            rejected: result.run.rejected,
            failed: result.run.failed,
          },
          "Scheduled Zoho invoice synchronization completed",
        );
      }
    } catch {
      finishMetric(true);
      logger.error("Scheduled Zoho invoice synchronization failed");
    } finally {
      if (activeAbortController === abortController) {
        activeAbortController = undefined;
      }
      inFlight = undefined;
      schedule();
    }
  };

  schedule();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      activeAbortController?.abort();
      try {
        await inFlight;
      } finally {
        workerStarted = false;
      }
    },
  };
}
