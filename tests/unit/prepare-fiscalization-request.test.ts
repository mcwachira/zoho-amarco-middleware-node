import { describe, expect, it, vi } from "vitest";

import type { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import type { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import type { FiscalCustomerProfileRepository } from "../../src/application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "../../src/application/fiscalization/fiscal-item-profile-repository.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";

const candidate: FiscalInvoiceCandidate = {
  zohoInvoiceId: "zoho-invoice-001",
  invoiceNumber: "INV-001",
  customerId: "customer-1",
  customerName: "Example Customer",
  currencyCode: "KES",
  lines: [
    {
      sourceLineId: "line-1",
      itemId: "item-1",
      description: "Test product",
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

const record = {
  id: "request-001",
  zohoInvoiceId: candidate.zohoInvoiceId,
  status: "Pending",
} as FiscalizationRecord;

function createHarness() {
  const invoiceService = {
    getFiscalInvoiceCandidate: vi.fn().mockResolvedValue({
      success: true,
      candidate,
    }),
  } satisfies Pick<ZohoInvoiceService, "getFiscalInvoiceCandidate">;

  const registrationService = {
    findExisting: vi.fn().mockResolvedValue(null),
    register: vi.fn().mockResolvedValue(record),
  } satisfies Pick<RegisterFiscalizationRequestService, "findExisting" | "register">;

  const customerProfiles = {
    findByZohoCustomerId: vi.fn().mockResolvedValue({
      id: "customer-profile-1",
      zohoCustomerId: "customer-1",
      companyName: "Example Ltd",
      clientPin: "P051234567X",
      headquarters: "Nairobi",
      address: "Main Road",
      postalCodeAndCity: "00100 Nairobi",
      exemptionNumber: null,
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
      updatedAt: new Date("2026-10-26T00:00:00.000Z"),
    }),
  } satisfies Pick<FiscalCustomerProfileRepository, "findByZohoCustomerId">;
  const itemProfiles = {
    findByZohoItemId: vi.fn().mockResolvedValue({
      id: "item-profile-1",
      zohoItemId: "item-1",
      measureUnit: "EA",
      hsCode: "1234.56.78",
      hsName: "Test product",
      vatClass: "A",
      vatGroupRate: "16.00",
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
      updatedAt: new Date("2026-10-26T00:00:00.000Z"),
    }),
  } satisfies Pick<FiscalItemProfileRepository, "findByZohoItemId">;

  const service = new PrepareFiscalizationRequestService(invoiceService, registrationService, {
    zohoOrganizationId: "organization-1",
    customerProfiles,
    itemProfiles,
    generateId: () => "request-001",
    now: () => new Date("2026-10-27T00:00:00.000Z"),
  });

  return { service, invoiceService, registrationService, customerProfiles, itemProfiles };
}

describe("PrepareFiscalizationRequestService", () => {
  it("maps the invoice and registers a Pending request", async () => {
    const { service, invoiceService, registrationService } = createHarness();

    const result = await service.prepare(candidate.zohoInvoiceId);

    expect(invoiceService.getFiscalInvoiceCandidate).toHaveBeenCalledWith(candidate.zohoInvoiceId);
    expect(registrationService.register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "request-001",
        invoice: candidate,
        snapshot: expect.objectContaining({
          schemaVersion: 1,
          zohoOrganizationId: "organization-1",
          invoice: candidate,
        }),
      }),
    );
    expect(result).toEqual({ kind: "registered", record });
  });

  it("exposes the registered invoice lookup used by idempotent imports", async () => {
    const { service, registrationService } = createHarness();

    await service.findExisting(candidate.zohoInvoiceId);

    expect(registrationService.findExisting).toHaveBeenCalledWith(candidate.zohoInvoiceId);
  });

  it("returns an existing durable request without refetching Zoho", async () => {
    const { service, invoiceService, registrationService } = createHarness();
    registrationService.findExisting.mockResolvedValue(record);

    await expect(service.synchronize(candidate.zohoInvoiceId)).resolves.toEqual({
      kind: "registered",
      record,
      alreadyExisted: true,
    });

    expect(invoiceService.getFiscalInvoiceCandidate).not.toHaveBeenCalled();
    expect(registrationService.register).not.toHaveBeenCalled();
  });

  it("returns the concurrently-created request after the unique key rejects a duplicate", async () => {
    const { service, registrationService } = createHarness();
    registrationService.register.mockRejectedValueOnce(
      new DuplicateZohoInvoiceError(candidate.zohoInvoiceId),
    );
    registrationService.findExisting.mockResolvedValueOnce(null).mockResolvedValueOnce(record);

    await expect(service.synchronize(candidate.zohoInvoiceId)).resolves.toEqual({
      kind: "registered",
      record,
      alreadyExisted: true,
    });
  });

  it("does not register an invoice that fails mapping", async () => {
    const { service, invoiceService, registrationService } = createHarness();

    invoiceService.getFiscalInvoiceCandidate.mockResolvedValue({
      success: false,
      errors: [{ code: "INVALID_INVOICE", message: "Invoice is invalid" }],
    });

    const result = await service.prepare(candidate.zohoInvoiceId);

    expect(result.kind).toBe("mapping-failed");
    expect(registrationService.register).not.toHaveBeenCalled();
  });

  it("propagates Zoho retrieval errors without registering a request", async () => {
    const { service, invoiceService, registrationService } = createHarness();

    invoiceService.getFiscalInvoiceCandidate.mockRejectedValue(new Error("Zoho request failed"));

    await expect(service.prepare(candidate.zohoInvoiceId)).rejects.toThrow("Zoho request failed");

    expect(registrationService.register).not.toHaveBeenCalled();
  });

  it("does not register an invoice without its customer profile", async () => {
    const { service, registrationService, customerProfiles } = createHarness();
    customerProfiles.findByZohoCustomerId.mockResolvedValue(null);

    const result = await service.prepare(candidate.zohoInvoiceId);

    expect(result.kind).toBe("snapshot-failed");
    expect(registrationService.register).not.toHaveBeenCalled();
  });

  it("does not register an invoice without a profile for each item", async () => {
    const { service, registrationService, itemProfiles } = createHarness();
    itemProfiles.findByZohoItemId.mockResolvedValue(null);

    const result = await service.prepare(candidate.zohoInvoiceId);

    expect(result.kind).toBe("snapshot-failed");
    expect(registrationService.register).not.toHaveBeenCalled();
  });

  it("rejects a Zoho invoice identity mismatch before registration", async () => {
    const { service, invoiceService, registrationService } = createHarness();
    invoiceService.getFiscalInvoiceCandidate.mockResolvedValue({
      success: true,
      candidate: { ...candidate, zohoInvoiceId: "another-invoice" },
    });

    const result = await service.prepare(candidate.zohoInvoiceId);

    expect(result.kind).toBe("mapping-failed");
    expect(registrationService.register).not.toHaveBeenCalled();
  });
});
