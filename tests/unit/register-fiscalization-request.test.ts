import { describe, expect, it, vi } from "vitest";

import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { makeFiscalizationSnapshot } from "./fiscalization-snapshot-fixture.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";

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

const snapshot = await makeFiscalizationSnapshot(invoice);

const input = {
  id: "fiscalization-001",
  invoice,
  snapshot,
};

function createRepository() {
  let currentRecord: FiscalizationRecord | null = null;

  const repository = {
    findById: vi.fn(async (id: string) => (currentRecord?.id === id ? currentRecord : null)),
    findByZohoInvoiceId: vi.fn(async (zohoInvoiceId: string) =>
      currentRecord?.zohoInvoiceId === zohoInvoiceId ? currentRecord : null,
    ),

    create: vi.fn(async (record: FiscalizationRecord): Promise<void> => {
      currentRecord = record;
    }),

    claimPending: vi.fn(async (id: string) => {
      if (currentRecord === null || currentRecord.id !== id || currentRecord.status !== "Pending") {
        return null;
      }

      currentRecord = startFiscalization(currentRecord);
      return currentRecord;
    }),

    saveOutcome: vi.fn(async (): Promise<boolean> => false),
    markStaleInProgressOutcomeUnknown: vi.fn(async (): Promise<number> => 0),
  } satisfies FiscalizationRepository;

  return {
    repository,
    getCurrentRecord: () => currentRecord,
  };
}

describe("RegisterFiscalizationRequestService", () => {
  it("persists a Pending record for the mapped Zoho invoice", async () => {
    const { repository, getCurrentRecord } = createRepository();
    const service = new RegisterFiscalizationRequestService(repository);

    const result = await service.register(input);

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: input.id,
        zohoInvoiceId: invoice.zohoInvoiceId,
        status: "Pending",
      }),
    );
    expect(result.status).toBe("Pending");
    expect(result.zohoInvoiceId).toBe(invoice.zohoInvoiceId);
    expect(result.snapshot).toEqual(snapshot);
    expect(getCurrentRecord()).toEqual(result);
  });

  it("does not claim or save an outcome during registration", async () => {
    const { repository } = createRepository();
    const service = new RegisterFiscalizationRequestService(repository);

    await service.register(input);

    expect(repository.claimPending).not.toHaveBeenCalled();
    expect(repository.saveOutcome).not.toHaveBeenCalled();
  });

  it("propagates persistence errors without returning a registered record", async () => {
    const { repository } = createRepository();
    repository.create.mockRejectedValue(new Error("Database unavailable"));

    const service = new RegisterFiscalizationRequestService(repository);

    await expect(service.register(input)).rejects.toThrow("Database unavailable");
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.claimPending).not.toHaveBeenCalled();
  });

  it("rejects a snapshot that does not match the invoice identity", async () => {
    const { repository } = createRepository();
    const service = new RegisterFiscalizationRequestService(repository);

    await expect(
      service.register({
        ...input,
        invoice: { ...invoice, zohoInvoiceId: "different-invoice" },
      }),
    ).rejects.toThrow("does not match the invoice registration input");
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("propagates duplicate registration without replacing the original snapshot", async () => {
    const { repository } = createRepository();
    const duplicate = new DuplicateZohoInvoiceError(invoice.zohoInvoiceId);
    repository.create.mockRejectedValue(duplicate);
    const service = new RegisterFiscalizationRequestService(repository);

    await expect(service.register(input)).rejects.toBe(duplicate);
    expect(repository.create).toHaveBeenCalledOnce();
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ snapshot }));
    expect(repository.saveOutcome).not.toHaveBeenCalled();
  });
});
