import { describe, expect, it, vi } from "vitest";

import type {
  FiscalDevice,
  FiscalDeviceResult,
} from "../../src/application/fiscalization/fiscal-device.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import {
  FiscalizationClaimError,
  FiscalizationInvoiceMismatchError,
  FiscalizationPersistenceError,
  FiscalizationRequestNotFoundError,
  FiscalizationService,
} from "../../src/application/fiscalization/fiscalization-service.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import {
  createFiscalizationRecord,
  type FiscalizationRecord,
} from "../../src/domain/fiscalization/fiscalization-record.js";

const invoice: FiscalInvoiceCandidate = {
  zohoInvoiceId: "zoho-invoice-001",
  invoiceNumber: "INV-001",
  customerId: "customer-1",
  customerName: "Example Customer",
  currencyCode: "KES",
  lines: [
    {
      sourceLineId: "line-1",
      itemId: "item-1",
      description: "A test product",
      quantity: "2",
      unitPrice: "150",
      lineTotal: "300",
      taxId: "tax-1",
      taxName: "Source tax",
      taxType: "tax",
      taxPercentage: "16",
    },
  ],
  subtotal: "300",
  taxTotal: "48",
  total: "348",
};

const input = {
  id: "fiscalization-001",
  invoice,
};

const successfulResult: FiscalDeviceResult = {
  kind: "succeeded",
  receipt: {
    receiptNumber: "CU-000123",
    issuedAt: new Date("2026-10-23T06:00:00.000Z"),
  },
};

/**
 * Creates an in-memory repository with an already-registered record.
 * No real database connection is needed.
 */
function createRepository(initialRecord: FiscalizationRecord, events: string[] = []) {
  let currentRecord: FiscalizationRecord | null = initialRecord;

  const repository = {
    findById: vi.fn(async (id: string): Promise<FiscalizationRecord | null> => {
      events.push("find");
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

      // Simulate the database atomically claiming Pending -> InProgress.
      const claimed = startFiscalization(currentRecord);
      currentRecord = claimed;

      return claimed;
    }),

    saveOutcome: vi.fn(async (record: FiscalizationRecord): Promise<boolean> => {
      events.push("save");

      // Only save the result if the record is still InProgress.
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

    markStaleInProgressOutcomeUnknown: vi.fn(async (): Promise<number> => 0),
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

  // Processing must begin with a record registered before this service runs.
  const pendingRecord = createFiscalizationRecord({
    id: input.id,
    zohoInvoiceId: input.invoice.zohoInvoiceId,
  });

  const { repository, getCurrentRecord } = createRepository(pendingRecord, events);
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
  it("loads and claims an existing record before calling the device", async () => {
    const { service, events, repository, device } = createHarness();

    const result = await service.fiscalize(input);

    expect(events).toEqual(["find", "claim", "device", "save"]);
    expect(repository.findById).toHaveBeenCalledWith(input.id);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.claimPending).toHaveBeenCalledWith(input.id);
    expect(device.issueReceipt).toHaveBeenCalledTimes(1);
    expect(device.issueReceipt).toHaveBeenCalledWith(invoice);
    expect(result.status).toBe("Succeeded");
  });

  it("rejects a missing request without claiming or calling the device", async () => {
    const { service, repository, device } = createHarness();

    repository.findById.mockResolvedValue(null);

    await expect(service.fiscalize(input)).rejects.toBeInstanceOf(
      FiscalizationRequestNotFoundError,
    );

    expect(repository.claimPending).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(device.issueReceipt).not.toHaveBeenCalled();
  });

  it("rejects an invoice that does not match the registered request", async () => {
    const { service, repository, device } = createHarness();

    const mismatchedInput = {
      id: input.id,
      invoice: {
        ...invoice,
        zohoInvoiceId: "different-zoho-invoice",
      },
    };

    await expect(service.fiscalize(mismatchedInput)).rejects.toBeInstanceOf(
      FiscalizationInvoiceMismatchError,
    );

    expect(repository.findById).toHaveBeenCalledWith(input.id);
    expect(repository.claimPending).not.toHaveBeenCalled();
    expect(repository.create).not.toHaveBeenCalled();
    expect(device.issueReceipt).not.toHaveBeenCalled();
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

  it("records an unknown outcome when success contains an invalid receipt", async () => {
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
});
