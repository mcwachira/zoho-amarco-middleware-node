import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecoverStaleFiscalizationsService } from "../../src/application/fiscalization/recover-stale-fiscalizations.js";

vi.mock("../../src/observability/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../../src/observability/logger.js";
import { startStaleFiscalizationRecoveryWorker } from "../../src/application/fiscalization/stale-fiscalization-recovery-worker.js";

const INTERVAL_MS = 1_000;
const STALE_AGE_MS = 30 * 60 * 1000;
const NOW = new Date("2026-10-25T12:00:00.000Z");

function createService() {
  return {
    execute: vi.fn<RecoverStaleFiscalizationsService["execute"]>(),
  } as unknown as RecoverStaleFiscalizationsService;
}

describe("startStaleFiscalizationRecoveryWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the interval and uses the configured stale age", async () => {
    const service = createService();
    vi.mocked(service.execute).mockResolvedValue(0);

    const worker = startStaleFiscalizationRecoveryWorker({
      service,
      intervalMs: INTERVAL_MS,
      staleAgeMs: STALE_AGE_MS,
    });

    expect(service.execute).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(service.execute).toHaveBeenCalledTimes(1);
    expect(service.execute).toHaveBeenCalledWith({
      staleBefore: new Date(NOW.getTime() + INTERVAL_MS - STALE_AGE_MS),
      reason: expect.stringContaining("Reconcile the device and KRA records"),
    });

    await worker.stop();
  });

  it("logs recovered records", async () => {
    const service = createService();
    vi.mocked(service.execute).mockResolvedValue(2);

    const worker = startStaleFiscalizationRecoveryWorker({
      service,
      intervalMs: INTERVAL_MS,
      staleAgeMs: STALE_AGE_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        recoveredCount: 2,
        staleBefore: new Date(NOW.getTime() + INTERVAL_MS - STALE_AGE_MS),
      },
      "Stale fiscalization requests marked OutcomeUnknown; reconciliation is required",
    );

    await worker.stop();
  });

  it("logs failures and schedules another run", async () => {
    const service = createService();
    const error = new Error("Database unavailable; synthetic-access-token");

    vi.mocked(service.execute).mockRejectedValueOnce(error).mockResolvedValueOnce(0);

    const worker = startStaleFiscalizationRecoveryWorker({
      service,
      intervalMs: INTERVAL_MS,
      staleAgeMs: STALE_AGE_MS,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith("Stale fiscalization recovery run failed");
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      "synthetic-access-token",
    );

    await vi.advanceTimersByTimeAsync(INTERVAL_MS);

    expect(service.execute).toHaveBeenCalledTimes(2);

    await worker.stop();
  });

  it("cancels future runs when stopped", async () => {
    const service = createService();

    const worker = startStaleFiscalizationRecoveryWorker({
      service,
      intervalMs: INTERVAL_MS,
      staleAgeMs: STALE_AGE_MS,
    });

    await worker.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);

    expect(service.execute).not.toHaveBeenCalled();
  });

  it("rejects invalid timing configuration", () => {
    const service = createService();

    expect(() =>
      startStaleFiscalizationRecoveryWorker({
        service,
        intervalMs: 0,
      }),
    ).toThrow("Recovery interval must be a positive finite number.");

    expect(() =>
      startStaleFiscalizationRecoveryWorker({
        service,
        staleAgeMs: Number.NaN,
      }),
    ).toThrow("Stale age must be a positive finite number.");
  });
});
