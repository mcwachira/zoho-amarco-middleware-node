import { logger } from "../../observability/logger.js";
import type { ZohoInvoiceSynchronizationService } from "./zoho-invoice-synchronization.js";

let workerStarted = false;

export function startZohoInvoiceSyncWorker(options: {
  readonly service: ZohoInvoiceSynchronizationService;
  readonly intervalMs: number;
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

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = run();
    }, options.intervalMs);
    timer.unref();
  };

  const run = async (): Promise<void> => {
    try {
      const result = await options.service.execute();
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
      logger.error("Scheduled Zoho invoice synchronization failed");
    } finally {
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
      try {
        await inFlight;
      } finally {
        workerStarted = false;
      }
    },
  };
}
