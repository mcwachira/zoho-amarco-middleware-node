import { logger } from "../../observability/logger.js";
import {
  operationalMetrics,
  safelyBeginJobMetric,
  safelyIncrementMetric,
  safelyMarkReconciliationSuccess,
  type OperationalMetrics,
} from "../../observability/operational-metrics.js";
import type { EtimsReportingOperationDetails } from "../../domain/fiscalization/etims-reporting.js";
import type { EtimsReportingService } from "./etims-reporting-service.js";
import { EtimsSubmissionPayloadIntegrityError } from "./etims-submission-payload.js";

export interface EtimsReconciliationPayloadResolver {
  /** Returns the exact immutable payload used at submission, or unavailable. */
  load(
    details: EtimsReportingOperationDetails,
    signal: AbortSignal,
  ): Promise<
    { readonly available: true; readonly payload: unknown } | { readonly available: false }
  >;
}

export interface EtimsReconciliationWorkerOptions {
  readonly service: Pick<
    EtimsReportingService,
    | "getReadiness"
    | "listReconciliationCandidates"
    | "reconcile"
    | "recoverStaleInProgress"
    | "blockReconciliation"
  >;
  readonly payloadResolver: EtimsReconciliationPayloadResolver;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly staleAgeMs: number;
  readonly operationTimeoutMs?: number;
  readonly maxRuntimeMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly now?: () => Date;
  readonly metrics?: OperationalMetrics;
}

export interface EtimsReconciliationBatchResult {
  readonly candidates: number;
  readonly attempted: number;
  readonly reconciled: number;
  readonly pending: number;
  readonly exhausted: number;
  readonly unavailablePayload: number;
  readonly failed: number;
  readonly cancelled: boolean;
}

const MAX_BATCH_SIZE = 100;
const DEFAULT_RETRY_BASE_DELAY_MS = 30_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 30 * 60_000;
let workerStarted = false;

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
}

function isDue(
  details: EtimsReportingOperationDetails,
  now: Date,
  maxAttempts: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): "due" | "backoff" | "exhausted" | "active" {
  const attempts = details.attempts
    .filter((attempt) => attempt.attemptType === "reconciliation")
    .sort((left, right) => right.attemptNumber - left.attemptNumber);
  const lastAttempt = attempts[0];
  const attemptNumber = details.operation.reconciliationAttemptNumber;

  if (attemptNumber >= maxAttempts) return "exhausted";
  if (lastAttempt && lastAttempt.completedAt === null) return "active";
  if (!lastAttempt?.completedAt) return "due";

  const exponent = Math.min(Math.max(lastAttempt.attemptNumber - 1, 0), 30);
  const delay = Math.min(retryBaseDelayMs * 2 ** exponent, retryMaxDelayMs);
  return now.getTime() - lastAttempt.completedAt.getTime() >= delay ? "due" : "backoff";
}

export async function runEtimsReconciliationBatch(
  options: EtimsReconciliationWorkerOptions,
  signal: AbortSignal,
): Promise<EtimsReconciliationBatchResult> {
  const zero = {
    candidates: 0,
    attempted: 0,
    reconciled: 0,
    pending: 0,
    exhausted: 0,
    unavailablePayload: 0,
    failed: 0,
    cancelled: signal.aborted,
  };
  const readiness = options.service.getReadiness();
  if (!options.enabled || !readiness.enabled || readiness.status !== "ready") return zero;
  if (!readiness.capabilities.supportsReconciliation || signal.aborted) return zero;

  const now = options.now ?? (() => new Date());
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const staleBefore = new Date(now().getTime() - options.staleAgeMs);
  let result = { ...zero, cancelled: false };

  try {
    await options.service.recoverStaleInProgress(staleBefore);
    const candidates = await options.service.listReconciliationCandidates(options.batchSize);
    result = { ...result, candidates: candidates.length };

    for (const details of candidates) {
      if (signal.aborted) {
        result = { ...result, cancelled: true };
        break;
      }
      const eligibility = isDue(
        details,
        now(),
        options.maxAttempts,
        retryBaseDelayMs,
        retryMaxDelayMs,
      );
      if (eligibility === "exhausted") {
        result = { ...result, exhausted: result.exhausted + 1 };
        continue;
      }
      if (eligibility !== "due") continue;

      try {
        const resolved = await options.payloadResolver.load(details, signal);
        if (signal.aborted) {
          result = { ...result, cancelled: true };
          break;
        }
        if (!resolved.available) {
          await options.service.blockReconciliation(
            details.operation.id,
            "payload_missing",
            "The immutable submission payload required for reconciliation is unavailable.",
          );
          result = { ...result, unavailablePayload: result.unavailablePayload + 1 };
          continue;
        }

        const updated = await options.service.reconcile(
          details.operation.id,
          resolved.payload,
          signal,
        );
        const latestAttempt = [...updated.attempts]
          .filter((item) => item.attemptType === "reconciliation")
          .sort((left, right) => right.attemptNumber - left.attemptNumber)[0];
        const didCompleteAttempt =
          updated.operation.reconciliationAttemptNumber >
            details.operation.reconciliationAttemptNumber &&
          latestAttempt?.attemptNumber === updated.operation.reconciliationAttemptNumber &&
          latestAttempt.completedAt !== null;
        if (!didCompleteAttempt) continue;
        const pending =
          updated.operation.status === "reconciliation_required" ||
          latestAttempt?.outcome === "pending";
        result = {
          ...result,
          attempted: result.attempted + 1,
          reconciled:
            result.reconciled +
            Number(
              updated.operation.status === "accepted" || updated.operation.status === "rejected",
            ),
          pending: result.pending + Number(pending),
        };
        if (updated.operation.status === "accepted" || updated.operation.status === "rejected") {
          safelyMarkReconciliationSuccess(options.metrics ?? operationalMetrics, now());
        }
        safelyIncrementMetric(
          options.metrics ?? operationalMetrics,
          "reconciliations",
          pending ? "uncertain" : "reconciled",
        );
      } catch (error) {
        if (error instanceof EtimsSubmissionPayloadIntegrityError) {
          await options.service.blockReconciliation(
            details.operation.id,
            "payload_integrity_failed",
            "The stored submission payload is missing or failed integrity validation.",
          );
          result = { ...result, unavailablePayload: result.unavailablePayload + 1 };
        } else {
          result = { ...result, failed: result.failed + 1 };
        }
      }
    }
  } catch {
    result = { ...result, failed: result.failed + 1 };
  }
  return { ...result, cancelled: result.cancelled || signal.aborted };
}

export function startEtimsReconciliationWorker(options: EtimsReconciliationWorkerOptions): {
  readonly stop: () => Promise<void>;
} {
  assertIntegerRange(options.intervalMs, 10_000, 86_400_000, "eTIMS reconciliation interval");
  assertIntegerRange(options.batchSize, 1, MAX_BATCH_SIZE, "eTIMS reconciliation batch size");
  assertIntegerRange(options.maxAttempts, 1, 20, "eTIMS reconciliation maximum attempts");
  assertIntegerRange(options.staleAgeMs, 30_000, 86_400_000, "eTIMS reconciliation stale age");
  assertIntegerRange(
    options.operationTimeoutMs ?? 15_000,
    1_000,
    120_000,
    "eTIMS reconciliation operation timeout",
  );
  assertIntegerRange(
    options.maxRuntimeMs ?? 120_000,
    10_000,
    1_800_000,
    "eTIMS reconciliation maximum batch runtime",
  );
  assertIntegerRange(
    options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    1_000,
    86_400_000,
    "eTIMS reconciliation retry base delay",
  );
  assertIntegerRange(
    options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    1_000,
    86_400_000,
    "eTIMS reconciliation retry maximum delay",
  );
  if (!options.enabled) {
    return { stop: async () => undefined };
  }
  if (workerStarted) throw new Error("eTIMS reconciliation worker is already running.");
  workerStarted = true;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let activeAbortController: AbortController | undefined;

  const schedule = (): void => {
    if (stopped || !options.enabled) return;
    timer = setTimeout(() => {
      timer = undefined;
      activeAbortController = new AbortController();
      inFlight = run(activeAbortController);
    }, options.intervalMs);
    timer.unref();
  };

  const run = async (controller: AbortController): Promise<void> => {
    const finishMetric = safelyBeginJobMetric(
      options.metrics ?? operationalMetrics,
      "etims_reconciliation",
    );
    const batchTimeout = setTimeout(() => controller.abort(), options.maxRuntimeMs ?? 120_000);
    batchTimeout.unref();
    try {
      const result = await runEtimsReconciliationBatch(options, controller.signal);
      finishMetric(result.failed > 0);
      logger.info(
        {
          candidates: result.candidates,
          attempted: result.attempted,
          reconciled: result.reconciled,
          pending: result.pending,
          exhausted: result.exhausted,
          unavailablePayload: result.unavailablePayload,
          failed: result.failed,
          cancelled: result.cancelled,
        },
        "Scheduled eTIMS reconciliation batch completed",
      );
    } catch {
      finishMetric(true);
      logger.error("Scheduled eTIMS reconciliation batch failed");
    } finally {
      clearTimeout(batchTimeout);
      if (activeAbortController === controller) activeAbortController = undefined;
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
