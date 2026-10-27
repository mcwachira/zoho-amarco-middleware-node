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
});
