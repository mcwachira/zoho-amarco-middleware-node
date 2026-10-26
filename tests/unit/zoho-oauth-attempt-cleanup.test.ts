import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ZohoOAuthAttemptRepository } from "../../src/application/zoho/oauth-attempt-repository.js";

vi.mock("../../src/observability/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../../src/observability/logger.js";
import { startZohoOAuthAttemptCleanup } from "../../src/application/zoho/zoho-oauth-attempt-cleanup.js";

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

function createRepository() {
  return {
    deleteExpired: vi.fn<ZohoOAuthAttemptRepository["deleteExpired"]>(),
  } as unknown as ZohoOAuthAttemptRepository;
}

describe("startZohoOAuthAttemptCleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs cleanup after the configured interval", async () => {
    const repository = createRepository();
    vi.mocked(repository.deleteExpired).mockResolvedValue(2);

    const cleanup = startZohoOAuthAttemptCleanup({ repository });

    expect(repository.deleteExpired).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CLEANUP_INTERVAL_MS);

    expect(repository.deleteExpired).toHaveBeenCalledTimes(1);
    expect(repository.deleteExpired).toHaveBeenCalledWith(expect.any(Date));
    expect(logger.info).toHaveBeenCalledWith(
      { deletedCount: 2 },
      "Expired Zoho OAuth attempts cleaned up",
    );

    await cleanup.stop();
  });

  it("logs cleanup failures and continues scheduling future runs", async () => {
    const repository = createRepository();
    const databaseError = new Error("Database cleanup failed");

    vi.mocked(repository.deleteExpired)
      .mockRejectedValueOnce(databaseError)
      .mockResolvedValueOnce(0);

    const cleanup = startZohoOAuthAttemptCleanup({
      repository,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    expect(logger.error).toHaveBeenCalledWith(
      { err: databaseError },
      "Failed to clean up expired Zoho OAuth attempts",
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(repository.deleteExpired).toHaveBeenCalledTimes(2);

    await cleanup.stop();
  });

  it("cancels future runs when stopped", async () => {
    const repository = createRepository();

    const cleanup = startZohoOAuthAttemptCleanup({
      repository,
      intervalMs: 1_000,
    });

    await cleanup.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(repository.deleteExpired).not.toHaveBeenCalled();
  });

  it("waits for an in-progress cleanup before stopping", async () => {
    const repository = createRepository();

    let resolveCleanup!: (count: number) => void;

    vi.mocked(repository.deleteExpired).mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    const cleanup = startZohoOAuthAttemptCleanup({
      repository,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);

    let stopped = false;
    const stopPromise = cleanup.stop().then(() => {
      stopped = true;
    });

    expect(stopped).toBe(false);

    resolveCleanup(0);
    await stopPromise;

    expect(stopped).toBe(true);
    expect(repository.deleteExpired).toHaveBeenCalledTimes(1);
  });
});
