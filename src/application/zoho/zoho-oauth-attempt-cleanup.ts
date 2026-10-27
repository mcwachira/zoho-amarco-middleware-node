import type { ZohoOAuthAttemptRepository } from "./oauth-attempt-repository.js";
import { logger } from "../../observability/logger.js";

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

interface ZohoOAuthAttemptCleanupOptions {
  repository: ZohoOAuthAttemptRepository;
  intervalMs?: number;
}

/**
 * Periodically removes expired OAuth authorization attempts.
 *
 * Cleanup failures are logged without stopping the application.
 * The timer is scheduled after each run, preventing overlapping jobs.
 */
export function startZohoOAuthAttemptCleanup({
  repository,
  intervalMs = CLEANUP_INTERVAL_MS,
}: ZohoOAuthAttemptCleanupOptions): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNextRun = (): void => {
    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      inFlight = runCleanup();
    }, intervalMs);

    // The cleanup timer alone must not keep Node.js alive.
    timer.unref();
  };

  const runCleanup = async (): Promise<void> => {
    try {
      const deletedCount = await repository.deleteExpired(new Date());

      if (deletedCount > 0) {
        logger.info({ deletedCount }, "Expired Zoho OAuth attempts cleaned up");
      }
    } catch {
      logger.error("Failed to clean up expired Zoho OAuth attempts");
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

      // Allow an already-running database operation to finish.
      await inFlight;
    },
  };
}
