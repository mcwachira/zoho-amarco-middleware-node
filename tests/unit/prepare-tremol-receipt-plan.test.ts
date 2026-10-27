import { describe, expect, it, vi } from "vitest";
import type { FiscalCustomerProfileRepository } from "../../src/application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "../../src/application/fiscalization/fiscal-item-profile-repository.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import { PrepareTremolReceiptPlan } from "../../src/application/fiscalization/prepare-tremol-receipt-plan.js";

const invoice: FiscalInvoiceCandidate = {
  zohoInvoiceId: "inv-1001",
  invoiceNumber: "INV-1001",
  customerId: "customer-1",
  customerName: "Example Customer Ltd",
  currencyCode: "KES",
  lines: [
    {
      sourceLineId: "line-1",
      itemId: "item-1",
      description: "Consulting service",
      quantity: "1",
      unitPrice: "100.00",
      lineTotal: "100.00",
      taxId: "tax-1",
      taxName: "Example tax",
      taxType: null,
      taxPercentage: "0",
    },
  ],
  subtotal: "100.00",
  taxTotal: "0.00",
  total: "100.00",
};

const customer = {
  id: "profile-1",
  zohoCustomerId: "customer-1",
  companyName: "Example Customer Ltd",
  clientPin: "P051234567X",
  headquarters: "Diani",
  address: "Main Road",
  postalCodeAndCity: "80400 Ukunda",
  exemptionNumber: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const item = {
  id: "item-profile-1",
  zohoItemId: "item-1",
  measureUnit: "EA",
  hsCode: "1234.56.78",
  hsName: "Consulting",
  vatClass: "A",
  vatGroupRate: "0",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

function createService(options?: { customer?: typeof customer | null; item?: typeof item | null }) {
  const customerProfiles = {
    findByZohoCustomerId: vi
      .fn()
      .mockResolvedValue(options && "customer" in options ? options.customer : customer),
  } as unknown as FiscalCustomerProfileRepository;

  const itemProfiles = {
    findByZohoItemId: vi.fn().mockResolvedValue(options && "item" in options ? options.item : item),
  } as unknown as FiscalItemProfileRepository;

  return {
    service: new PrepareTremolReceiptPlan(customerProfiles, itemProfiles),
    customerProfiles,
    itemProfiles,
  };
}

describe("PrepareTremolReceiptPlan", () => {
  it("rejects an invoice without a customer ID", async () => {
    const { service, customerProfiles } = createService();
    const result = await service.execute({ ...invoice, customerId: null });

    expect(result.success).toBe(false);
    expect(customerProfiles.findByZohoCustomerId).not.toHaveBeenCalled();
  });

  it("rejects a missing customer fiscal profile", async () => {
    const { service, itemProfiles } = createService({ customer: null });
    const result = await service.execute(invoice);

    expect(result.success).toBe(false);
    expect(itemProfiles.findByZohoItemId).not.toHaveBeenCalled();

    if (!result.success) {
      expect(result.errors[0]?.message).toContain("No fiscal profile is configured");
    }
  });

  it("rejects a missing item fiscal profile", async () => {
    const { service } = createService({ item: null });
    const result = await service.execute(invoice);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.errors[0]?.message).toContain("No fiscal profile is configured");
    }
  });
  it("rejects a customer profile belonging to a different Zoho customer", async () => {
    const { service, itemProfiles } = createService({
      customer: {
        ...customer,
        zohoCustomerId: "customer-999",
      },
    });

    const result = await service.execute(invoice);

    expect(result.success).toBe(false);
    expect(itemProfiles.findByZohoItemId).not.toHaveBeenCalled();

    if (!result.success) {
      expect(result.errors[0]?.field).toBe("customer");
      expect(result.errors[0]?.message).toContain("does not match the Zoho invoice customer");
    }
  });

  it("rejects an item profile belonging to a different Zoho item", async () => {
    const { service } = createService({
      item: {
        ...item,
        zohoItemId: "item-999",
      },
    });

    const result = await service.execute(invoice);

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.errors[0]?.field).toBe("invoice.lines[0].itemId");
      expect(result.errors[0]?.message).toContain("does not match the Zoho invoice item");
    }
  });

  it("prepares a non-executable plan using stored profiles", async () => {
    const { service, customerProfiles, itemProfiles } = createService();
    const result = await service.execute(invoice);

    expect(result.success).toBe(true);
    expect(customerProfiles.findByZohoCustomerId).toHaveBeenCalledWith("customer-1");
    expect(itemProfiles.findByZohoItemId).toHaveBeenCalledWith("item-1");

    if (result.success) {
      expect(result.plan.executable).toBe(false);
      expect(result.plan.commands).toHaveLength(3);
    }
  });

  it("rejects a non-KES invoice before looking up fiscal profiles", async () => {
    const { service, customerProfiles, itemProfiles } = createService();

    const result = await service.execute({
      ...invoice,
      currencyCode: "USD",
    });

    expect(result).toEqual({
      success: false,
      errors: [
        {
          field: "currencyCode",
          message:
            "Only KES invoices are supported by the current Tremol receipt-planning workflow.",
        },
      ],
    });

    expect(customerProfiles.findByZohoCustomerId).not.toHaveBeenCalled();
    expect(itemProfiles.findByZohoItemId).not.toHaveBeenCalled();
  });
});
