export type MetricOutcome = "success" | "failure" | "timeout" | "uncertain" | "reconciled";
export type BoundedMetricOutcome =
  | MetricOutcome
  | "2xx"
  | "4xx"
  | "5xx"
  | "opened"
  | "resolved"
  | "escalated"
  | "available"
  | "unavailable"
  | "not_configured";
export type MetricName =
  | "http_requests"
  | "requests_processed"
  | "device_attempts"
  | "etims_attempts"
  | "reconciliations"
  | "zoho_writeback"
  | "manual_review_actions"
  | "database_checks"
  | "database_failures"
  | "device_checks"
  | "dependency_checks"
  | "adapter_timeouts";

const HTTP_DURATION_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 5_000] as const;

export interface JobHealth {
  readonly runs: number;
  readonly failures: number;
  readonly consecutiveFailures: number;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastReconciledAt: string | null;
  readonly lastDurationMs: number | null;
  readonly running: boolean;
  readonly activeWork: number;
}

/** In-process, low-cardinality counters and job health; no identifiers become labels. */
export class OperationalMetrics {
  private readonly counters = new Map<string, number>();
  private readonly jobs = new Map<string, JobHealth>();
  private httpDurationCount = 0;
  private httpDurationSumMs = 0;
  private readonly httpDurationBuckets = new Map<number | "+Inf", number>([
    ...HTTP_DURATION_BUCKETS_MS.map((bound) => [bound, 0] as const),
    ["+Inf", 0],
  ]);

  increment(metric: MetricName, outcome: BoundedMetricOutcome): void {
    const key = `${metric}.${outcome}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeHttpDuration(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.httpDurationCount += 1;
    this.httpDurationSumMs += durationMs;
    for (const bound of HTTP_DURATION_BUCKETS_MS) {
      if (durationMs <= bound)
        this.httpDurationBuckets.set(bound, this.httpDurationBuckets.get(bound)! + 1);
    }
    this.httpDurationBuckets.set("+Inf", this.httpDurationBuckets.get("+Inf")! + 1);
  }

  beginJob(
    name: "stale_recovery" | "zoho_sync" | "etims_reconciliation",
    startedAt = new Date(),
  ): (failed?: boolean) => void {
    const prior = this.jobs.get(name) ?? {
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastReconciledAt: null,
      lastDurationMs: null,
      running: false,
      activeWork: 0,
    };
    const start = startedAt.getTime();
    this.jobs.set(name, {
      ...prior,
      running: true,
      activeWork: prior.activeWork + 1,
      lastStartedAt: startedAt.toISOString(),
    });
    let finished = false;
    return (failed = false) => {
      if (finished) return;
      finished = true;
      const completedAt = new Date();
      const current = this.jobs.get(name)!;
      this.jobs.set(name, {
        ...current,
        runs: current.runs + 1,
        failures: current.failures + Number(failed),
        consecutiveFailures: failed ? current.consecutiveFailures + 1 : 0,
        lastFinishedAt: completedAt.toISOString(),
        lastSuccessAt: failed ? current.lastSuccessAt : completedAt.toISOString(),
        lastDurationMs: Math.max(0, completedAt.getTime() - start),
        running: current.activeWork > 1,
        activeWork: Math.max(0, current.activeWork - 1),
      });
    };
  }

  snapshot(): {
    readonly counters: Readonly<Record<string, number>>;
    readonly jobs: Readonly<Record<string, JobHealth>>;
    readonly httpDurationMs: {
      readonly count: number;
      readonly sum: number;
      readonly buckets: Readonly<Record<string, number>>;
    };
  } {
    return {
      counters: Object.fromEntries(this.counters),
      jobs: Object.fromEntries(this.jobs),
      httpDurationMs: {
        count: this.httpDurationCount,
        sum: this.httpDurationSumMs,
        buckets: Object.fromEntries(this.httpDurationBuckets),
      },
    };
  }

  markReconciliationSuccess(at = new Date()): void {
    const prior = this.jobs.get("etims_reconciliation");
    if (prior) {
      this.jobs.set("etims_reconciliation", { ...prior, lastReconciledAt: at.toISOString() });
    }
  }
}

export const operationalMetrics = new OperationalMetrics();

export function safelyIncrementMetric(
  metrics: OperationalMetrics,
  metric: Parameters<OperationalMetrics["increment"]>[0],
  outcome: Parameters<OperationalMetrics["increment"]>[1],
): void {
  try {
    metrics.increment(metric, outcome);
  } catch {
    // Telemetry must never alter fiscal or API outcomes.
  }
}

export function safelyObserveHttpDuration(metrics: OperationalMetrics, durationMs: number): void {
  try {
    metrics.observeHttpDuration(durationMs);
  } catch {
    /* Telemetry must never affect requests. */
  }
}

export function safelyBeginJobMetric(
  metrics: OperationalMetrics,
  name: "stale_recovery" | "zoho_sync" | "etims_reconciliation",
): (failed?: boolean) => void {
  let finish: (failed?: boolean) => void;
  try {
    finish = metrics.beginJob(name);
  } catch {
    return () => undefined;
  }
  return (failed = false) => {
    try {
      finish(failed);
    } catch {
      // Telemetry must never alter job execution or recovery behavior.
    }
  };
}

export function safelyMarkReconciliationSuccess(
  metrics: OperationalMetrics,
  at = new Date(),
): void {
  try {
    metrics.markReconciliationSuccess(at);
  } catch {
    // Telemetry must never alter fiscal or API outcomes.
  }
}
