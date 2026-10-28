import { afterEach, describe, expect, it, vi } from "vitest";

import { startZohoInvoiceSyncWorker } from "../../src/application/zoho/zoho-invoice-sync-worker.js";
import type { ZohoInvoiceSynchronizationService } from "../../src/application/zoho/zoho-invoice-synchronization.js";

describe("Zoho invoice synchronization worker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the configured interval, schedules no duplicate worker, and stops cleanly", async () => {
    vi.useFakeTimers();
    const execute = vi.fn().mockResolvedValue({
      state: "succeeded",
      run: {
        id: "run-1",
        discovered: 1,
        imported: 1,
        duplicatesSkipped: 0,
        rejected: 0,
        failed: 0,
      },
    });
    const service = { execute } as unknown as ZohoInvoiceSynchronizationService;
    const worker = startZohoInvoiceSyncWorker({ service, intervalMs: 60_000 });

    expect(execute).not.toHaveBeenCalled();
    expect(() => startZohoInvoiceSyncWorker({ service, intervalMs: 60_000 })).toThrow(
      "Zoho invoice synchronization worker is already running.",
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).toHaveBeenCalledOnce();
    await worker.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects intervals shorter than one minute", () => {
    const service = { execute: vi.fn() } as unknown as ZohoInvoiceSynchronizationService;
    expect(() => startZohoInvoiceSyncWorker({ service, intervalMs: 59_999 })).toThrow(
      "Zoho synchronization interval must be at least one minute.",
    );
  });

  it("aborts an active synchronization before waiting for it to stop", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const execute = vi.fn(
      (providedSignal?: AbortSignal) =>
        new Promise<{ state: "failed"; run: { id: string } }>((resolve) => {
          signal = providedSignal;
          providedSignal?.addEventListener(
            "abort",
            () => resolve({ state: "failed", run: { id: "run-1" } }),
            { once: true },
          );
        }),
    );
    const worker = startZohoInvoiceSyncWorker({
      service: { execute } as unknown as ZohoInvoiceSynchronizationService,
      intervalMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(signal?.aborted).toBe(false);

    await worker.stop();

    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
