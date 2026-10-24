import { describe, expect, it, vi } from "vitest";

import type {
  FiscalDevice,
  FiscalDeviceResult,
} from "../../src/application/fiscalization/fiscal-device.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";

import {
  FiscalizationClaimError,
  FiscalizationPersistenceError,
  FiscalizationService,
} from "../../src/application/fiscalization/fiscalization-service.js";

import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";

import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
const input = {
  id: "fiscalization-001",
  zohoInvoiceId: "zoho-invoice-001",
};

const successfulResult: FiscalDeviceResult = {
  kind: "succeeded",
  receipt: {
    receiptNumber: "CU-000123",
    issuedAt: new Date("2026-10-23T06:00:00.000Z"),
  },
};

/**
 * Creates an in-memory repository for tests.
 *
 * This behaves like a small database but stores records only in memory.
 * No real database connection is needed.
 */

function createRepository(events: string[] = []) {
  let currentRecord: FiscalizationRecord | null = null;

  const repository = {
    findById: vi.fn(async (id: string): Promise<FiscalizationRecord | null> => {
      return currentRecord?.id === id ? currentRecord : null;
    }),

    create: vi.fn(async (record: FiscalizationRecord): Promise<void> => {
      events.push("create");
      currentRecord = record;
    }),

    claimPending: vi.fn(async (id: string): Promise<FiscalizationRecord | null> => {
      events.push("claim");
      if (currentRecord === null || currentRecord.id !== id || currentRecord.status !== "Pending") {
        return null;
      }
      // Simulate the database claiming Pending -> InProgress.
      const claimed = startFiscalization(currentRecord);
      currentRecord = claimed;

      return claimed;
    }),

    saveOutcome: vi.fn(async (record: FiscalizationRecord): Promise<boolean> => {
      events.push("save");

      // Only save the result if this record is still InProgress.
      if (
        currentRecord === null ||
        currentRecord.id !== record.id ||
        currentRecord.status !== "InProgress"
      ) {
        return false;
      }

      currentRecord = record;
      return true;
    }),
  } satisfies FiscalizationRepository;

  return {
    repository,
    getCurrentRecord: () => currentRecord,
  };
}
/**
 * Creates a mocked device that never contacts a physical printer.
 */
function createDevice(events: string[] = [], result: FiscalDeviceResult = successfulResult) {
  const device = {
    issueReceipt: vi.fn(async (): Promise<FiscalDeviceResult> => {
      events.push("device");
      return result;
    }),
  } satisfies FiscalDevice;

  return device;
}

function createHarness(result?: FiscalDeviceResult) {
  const events: string[] = [];
  const { repository, getCurrentRecord } = createRepository(events);
  const device = createDevice(events, result);
  const service = new FiscalizationService(repository, device);

  return {
    events,
    repository,
    device,
    service,
    getCurrentRecord,
  };
}

describe("FiscalizationService", () => {
  it("creates and claims the record before calling the device", async () => {
    const { service, events, repository, device } = createHarness();

    const result = await service.fiscalize(input);

    expect(events).toEqual(["create", "claim", "device", "save"]);
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.claimPending).toHaveBeenCalledWith(input.id);
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("Succeeded");
  });

  it("does not call the device when the record cannot be claimed", async () => {
    const { service, repository, device } = createHarness();

    repository.claimPending.mockResolvedValue(null);

    await expect(service.fiscalize(input)).rejects.toBeInstanceOf(FiscalizationClaimError);

    expect(device.issueReceipt).not.toHaveBeenCalled();
    expect(repository.saveOutcome).not.toHaveBeenCalled();
  });

  it("records a successful receipt", async () => {
    const { service, getCurrentRecord } = createHarness();

    const result = await service.fiscalize(input);

    expect(result.status).toBe("Succeeded");
    expect(result.receipt).toEqual(
      successfulResult.kind === "succeeded" ? successfulResult.receipt : null,
    );
    expect(result.failure).toBeNull();
    expect(result.outcomeUnknownReason).toBeNull();
    expect(getCurrentRecord()?.status).toBe("Succeeded");
  });

  it("records an unknown outcome when the device reports success with an invalid receipt", async () => {
    const invalidResult: FiscalDeviceResult = {
      kind: "succeeded",
      receipt: {
        receiptNumber: "   ",
        issuedAt: new Date("2026-10-23T06:00:00.000Z"),
      },
    };

    const { service, device, repository, getCurrentRecord } = createHarness(invalidResult);

    const result = await service.fiscalize(input);

    expect(result.status).toBe("OutcomeUnknown");
    expect(result.outcomeUnknownReason).toBeTruthy();
    expect(getCurrentRecord()?.status).toBe("OutcomeUnknown");
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
    expect(repository.saveOutcome).toHaveBeenCalledTimes(1);
  });

  it("records a confirmed device failure", async () => {
    const failureResult: FiscalDeviceResult = {
      kind: "failed",
      failure: {
        code: "DEVICE_REJECTED",
        message: "The device rejected the operation.",
      },
    };

    const { service, device } = createHarness(failureResult);

    const result = await service.fiscalize(input);

    expect(result.status).toBe("Failed");
    expect(result.receipt).toBeNull();
    expect(result.outcomeUnknownReason).toBeNull();
    expect(result.failure).toEqual(failureResult.kind === "failed" ? failureResult.failure : null);
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
  });

  it("records an explicitly uncertain device outcome", async () => {
    const uncertainResult: FiscalDeviceResult = {
      kind: "outcome-unknown",
      reason: "The device response was incomplete.",
    };

    const { service, device } = createHarness(uncertainResult);

    const result = await service.fiscalize(input);

    expect(result.status).toBe("OutcomeUnknown");
    expect(result.outcomeUnknownReason).toBe("The device response was incomplete.");
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
  });

  it("records an unexpected device exception as an unknown outcome", async () => {
    const { service, device, repository } = createHarness();

    device.issueReceipt.mockRejectedValue(new Error("Connection timed out"));

    const result = await service.fiscalize(input);

    expect(result.status).toBe("OutcomeUnknown");
    expect(repository.saveOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "OutcomeUnknown",
        outcomeUnknownReason: expect.stringContaining("could not be reliably confirmed"),
      }),
    );
    expect(result.outcomeUnknownReason).toContain("could not be reliably confirmed");
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the device call when saving the outcome throws", async () => {
    const { service, repository, device } = createHarness();

    repository.saveOutcome.mockRejectedValue(new Error("Database connection lost"));

    await expect(service.fiscalize(input)).rejects.toBeInstanceOf(FiscalizationPersistenceError);

    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
    expect(repository.saveOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the device call when saving the outcome returns false", async () => {
    const { service, repository, device } = createHarness();

    repository.saveOutcome.mockResolvedValue(false);

    await expect(service.fiscalize(input)).rejects.toBeInstanceOf(FiscalizationPersistenceError);

    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
    expect(repository.saveOutcome).toHaveBeenCalledTimes(1);
  });

  it("does not call the device when the Zoho invoice is a duplicate", async () => {
    const { service, repository, device } = createHarness();

    repository.create.mockRejectedValue(new DuplicateZohoInvoiceError(input.zohoInvoiceId));

    await expect(service.fiscalize(input)).rejects.toBeInstanceOf(DuplicateZohoInvoiceError);

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.claimPending).not.toHaveBeenCalled();
    expect(device.issueReceipt).not.toHaveBeenCalled();
    expect(repository.saveOutcome).not.toHaveBeenCalled();
  });
});
