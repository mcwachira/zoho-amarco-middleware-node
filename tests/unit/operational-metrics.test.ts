import { describe, expect, it } from "vitest";
import {
  OperationalMetrics,
  safelyBeginJobMetric,
  safelyIncrementMetric,
} from "../../src/observability/operational-metrics.js";

describe("operational metrics", () => {
  it("uses bounded outcome labels and exposes no caller identifiers", () => {
    const metrics = new OperationalMetrics();
    metrics.increment("device_attempts", "uncertain");
    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toEqual({ "device_attempts.uncertain": 1 });
    expect(JSON.stringify(snapshot)).not.toContain("invoice");
  });

  it("tracks job runs, duration, failure, and last success", () => {
    const metrics = new OperationalMetrics();
    const done = metrics.beginJob("stale_recovery");
    done(false);
    done(true);
    const health = metrics.snapshot().jobs["stale_recovery"]!;
    expect(health.runs).toBe(1);
    expect(health.failures).toBe(0);
    expect(health.lastSuccessAt).not.toBeNull();
    expect(health.running).toBe(false);
  });

  it("records HTTP latency in fixed buckets without request-specific labels", () => {
    const metrics = new OperationalMetrics();
    metrics.observeHttpDuration(12);
    metrics.observeHttpDuration(800);
    expect(metrics.snapshot().httpDurationMs).toEqual({
      count: 2,
      sum: 812,
      buckets: { "10": 0, "50": 1, "100": 1, "250": 1, "500": 1, "1000": 2, "5000": 2, "+Inf": 2 },
    });
    expect(JSON.stringify(metrics.snapshot())).not.toContain("request-id");
  });

  it("isolates metrics failures from application and job outcomes", () => {
    const metrics = new OperationalMetrics();
    metrics.increment = () => {
      throw new Error("metrics backend failed");
    };
    metrics.beginJob = () => {
      throw new Error("metrics backend failed");
    };
    expect(() => safelyIncrementMetric(metrics, "requests_processed", "success")).not.toThrow();
    expect(() => safelyBeginJobMetric(metrics, "zoho_sync")(false)).not.toThrow();
  });

  it("tracks consecutive job failures and confirmed reconciliation completion separately", () => {
    const metrics = new OperationalMetrics();
    metrics.beginJob("etims_reconciliation")(true);
    metrics.beginJob("etims_reconciliation")(true);
    const at = new Date("2026-10-27T07:30:00.000Z");
    metrics.markReconciliationSuccess(at);
    expect(metrics.snapshot().jobs["etims_reconciliation"]).toMatchObject({
      consecutiveFailures: 2,
      lastReconciledAt: at.toISOString(),
      activeWork: 0,
      running: false,
    });
    metrics.beginJob("etims_reconciliation")(false);
    expect(metrics.snapshot().jobs["etims_reconciliation"]?.consecutiveFailures).toBe(0);
  });
});
