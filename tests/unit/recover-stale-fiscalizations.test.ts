import { describe, expect, it, vi } from "vitest";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import { RecoverStaleFiscalizationsService } from "../../src/application/fiscalization/recover-stale-fiscalizations.js";

function createRepository() {
  return {
    findById: vi.fn(),
    create: vi.fn(),
    claimPending: vi.fn(),
    saveOutcome: vi.fn(),
    markStaleInProgressOutcomeUnknown: vi.fn(),
  } satisfies {
    [K in keyof FiscalizationRepository]: ReturnType<typeof vi.fn>;
  };
}

describe("RecoverStaleFiscalizationsService", () => {
  it("delegates recovery and returns the number of recovered records", async () => {
    const repository = createRepository();
    repository.markStaleInProgressOutcomeUnknown.mockResolvedValue(3);

    const service = new RecoverStaleFiscalizationsService(
      repository as unknown as FiscalizationRepository,
    );

    const staleBefore = new Date("2026-10-23T08:00:00.000Z");
    const result = await service.execute({
      staleBefore,
      reason: "  Recovery after an interrupted process.  ",
    });

    expect(result).toBe(3);
    expect(repository.markStaleInProgressOutcomeUnknown).toHaveBeenCalledWith(
      staleBefore,
      "Recovery after an interrupted process.",
    );
  });

  it("rejects an invalid cutoff date without accessing the repository", async () => {
    const repository = createRepository();
    const service = new RecoverStaleFiscalizationsService(
      repository as unknown as FiscalizationRepository,
    );

    await expect(
      service.execute({
        staleBefore: new Date(Number.NaN),
        reason: "Recovery after an interrupted process.",
      }),
    ).rejects.toThrow("Recovery cutoff must be a valid date.");

    expect(repository.markStaleInProgressOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("rejects a blank reason without accessing the repository", async () => {
    const repository = createRepository();
    const service = new RecoverStaleFiscalizationsService(
      repository as unknown as FiscalizationRepository,
    );

    await expect(
      service.execute({
        staleBefore: new Date("2026-10-23T08:00:00.000Z"),
        reason: "   ",
      }),
    ).rejects.toThrow("Recovery reason must not be empty.");

    expect(repository.markStaleInProgressOutcomeUnknown).not.toHaveBeenCalled();
  });

  it("rejects a reason longer than 2000 characters", async () => {
    const repository = createRepository();
    const service = new RecoverStaleFiscalizationsService(
      repository as unknown as FiscalizationRepository,
    );

    await expect(
      service.execute({
        staleBefore: new Date("2026-10-23T08:00:00.000Z"),
        reason: "x".repeat(2001),
      }),
    ).rejects.toThrow("Recovery reason must not exceed 2000 characters.");

    expect(repository.markStaleInProgressOutcomeUnknown).not.toHaveBeenCalled();
  });
});
