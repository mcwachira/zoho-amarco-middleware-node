import { describe, expect, it, vi } from "vitest";
import { GracefulShutdown } from "../../src/infrastructure/http/graceful-shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("graceful shutdown lifecycle", () => {
  it("stops background scheduling immediately, drains HTTP, then closes dependencies once", async () => {
    const server = deferred();
    const workers = deferred();
    const closeDependencies = vi.fn(async () => undefined);
    const stopBackgroundWork = vi.fn(() => workers.promise);
    const stopAcceptingRequests = vi.fn(() => server.promise);
    const lifecycle = new GracefulShutdown({
      stopAcceptingRequests,
      stopBackgroundWork,
      closeDependencies,
      forceCloseRequests: vi.fn(),
      timeoutMs: 10_000,
      onTimeout: vi.fn(),
    });
    const first = lifecycle.start();
    const duplicate = lifecycle.start();
    expect(first).toBe(duplicate);
    expect(lifecycle.isDraining()).toBe(true);
    await Promise.resolve();
    expect(stopBackgroundWork).toHaveBeenCalledOnce();
    expect(stopAcceptingRequests).toHaveBeenCalledOnce();
    expect(closeDependencies).not.toHaveBeenCalled();
    server.resolve();
    await Promise.resolve();
    expect(closeDependencies).not.toHaveBeenCalled();
    workers.resolve();
    await first;
    expect(closeDependencies).toHaveBeenCalledOnce();
  });

  it("forces remaining HTTP connections closed after the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => {});
      const forceCloseRequests = vi.fn();
      const onTimeout = vi.fn();
      const lifecycle = new GracefulShutdown({
        stopAcceptingRequests: () => never,
        stopBackgroundWork: async () => undefined,
        closeDependencies: async () => undefined,
        forceCloseRequests,
        timeoutMs: 1_000,
        onTimeout,
      });
      void lifecycle.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(forceCloseRequests).toHaveBeenCalledOnce();
      expect(lifecycle.isDraining()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
