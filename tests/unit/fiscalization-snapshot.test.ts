import { describe, expect, it, vi } from "vitest";

import {
  buildFiscalizationSnapshot,
  parseFiscalizationSnapshot,
  FiscalizationSnapshotError,
  UnsupportedFiscalizationSnapshotVersionError,
} from "../../src/application/fiscalization/fiscalization-snapshot.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import { makeFiscalizationSnapshot } from "./fiscalization-snapshot-fixture.js";

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
      description: "Test product",
      quantity: "2.000",
      unitPrice: "0.10000",
      lineTotal: "0.20000000000000002",
      taxId: "tax-1",
      taxName: "Source tax",
      taxType: "tax",
      taxPercentage: "16",
    },
  ],
  subtotal: "0.20000000000000002",
  taxTotal: "0.0320000000000000032",
  total: "0.2320000000000000232",
};

function createProfileRepositories() {
  return {
    customerProfiles: {
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
    },
    itemProfiles: {
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
    },
  };
}

describe("fiscalization snapshots", () => {
  it("captures validated invoice, organization, customer, and line profile inputs", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      zohoOrganizationId: "organization-1",
      invoice,
      customer: {
        zohoCustomerId: "customer-1",
        companyName: "Example Ltd",
      },
      lineProfiles: [
        {
          sourceLineId: "line-1",
          zohoItemId: "item-1",
          vatClass: "A",
        },
      ],
    });
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.invoice.lines)).toBe(true);
  });

  it("preserves decimal strings without floating-point arithmetic", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);

    expect(snapshot.invoice.lines[0]?.unitPrice).toBe("0.10000");
    expect(snapshot.invoice.total).toBe("0.2320000000000000232");
  });

  it("archives and integrity-validates source invoice date and discount evidence", async () => {
    const invoiceWithDiscountEvidence: FiscalInvoiceCandidate = {
      ...invoice,
      invoiceDate: "2026-10-27",
      discount: "5%",
      discountBeforeTax: true,
      lines: [{ ...invoice.lines[0]!, discountAmount: "1.25" }],
    };
    const snapshot = await makeFiscalizationSnapshot(invoiceWithDiscountEvidence);
    const parsed = parseFiscalizationSnapshot(snapshot, snapshot.schemaVersion);

    expect(parsed.invoice).toMatchObject({
      invoiceDate: "2026-10-27",
      discount: "5%",
      discountBeforeTax: true,
      lines: [{ discountAmount: "1.25" }],
    });
  });

  it("fails preparation with a sanitized validation result when configured payment retrieval fails", async () => {
    const { customerProfiles, itemProfiles } = createProfileRepositories();
    const result = await buildFiscalizationSnapshot({
      invoice,
      zohoOrganizationId: "organization-1",
      customerProfiles,
      itemProfiles,
      paymentsClient: {
        getInvoicePayments: vi.fn().mockRejectedValue(new Error("secret-bearing transport error")),
      },
    });

    expect(result).toEqual({
      success: false,
      errors: [
        {
          field: "payments",
          message:
            "Zoho payment evidence could not be retrieved; the fiscalization request was not registered.",
        },
      ],
    });
  });

  it("follows every reported payment page and preserves the applied payment evidence", async () => {
    const { customerProfiles, itemProfiles } = createProfileRepositories();
    const getInvoicePayments = vi
      .fn()
      .mockResolvedValueOnce({
        page: 1,
        hasMore: true,
        payments: [
          {
            paymentId: "payment-1",
            paymentNumber: null,
            paymentMode: "cash",
            amount: "10.25",
            date: null,
            referenceNumber: null,
            description: null,
            source: { payment_id: "payment-1", private_note: "synthetic sensitive fixture" },
          },
        ],
      })
      .mockResolvedValueOnce({ page: 2, hasMore: false, payments: [] });
    const result = await buildFiscalizationSnapshot({
      invoice,
      zohoOrganizationId: "organization-1",
      customerProfiles,
      itemProfiles,
      paymentsClient: { getInvoicePayments },
      registeredAt: new Date("2026-10-27T00:00:00.000Z"),
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.snapshot.payments).toMatchObject([
        {
          paymentId: "payment-1",
          amount: "10.25",
          paymentMode: "cash",
          source: { responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        },
      ]);
      expect(JSON.stringify(result.snapshot.payments)).not.toContain("synthetic sensitive fixture");
      expect(JSON.stringify(result.snapshot.payments)).not.toContain('"payment_id"');
    }
    expect(getInvoicePayments).toHaveBeenNthCalledWith(1, invoice.zohoInvoiceId, undefined, 1);
    expect(getInvoicePayments).toHaveBeenNthCalledWith(2, invoice.zohoInvoiceId, undefined, 2);
  });

  it("rejects missing required customer or item mappings", async () => {
    const { customerProfiles, itemProfiles } = createProfileRepositories();
    customerProfiles.findByZohoCustomerId.mockResolvedValue(null);

    const missingCustomer = await buildFiscalizationSnapshot({
      invoice,
      zohoOrganizationId: "organization-1",
      customerProfiles,
      itemProfiles,
    });

    expect(missingCustomer.success).toBe(false);
    expect(itemProfiles.findByZohoItemId).not.toHaveBeenCalled();

    customerProfiles.findByZohoCustomerId.mockResolvedValue({
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
    });
    itemProfiles.findByZohoItemId.mockResolvedValue(null);

    const missingItem = await buildFiscalizationSnapshot({
      invoice,
      zohoOrganizationId: "organization-1",
      customerProfiles,
      itemProfiles,
    });
    expect(missingItem.success).toBe(false);
  });

  it("rejects malformed decimal input before persistence", async () => {
    const { customerProfiles, itemProfiles } = createProfileRepositories();
    const invalidInvoice = { ...invoice, total: "NaN" };
    const result = await buildFiscalizationSnapshot({
      invoice: invalidInvoice,
      zohoOrganizationId: "organization-1",
      customerProfiles,
      itemProfiles,
    });

    expect(result.success).toBe(false);
    expect(customerProfiles.findByZohoCustomerId).not.toHaveBeenCalled();
  });

  it("rejects a snapshot whose contents no longer match its integrity identifier", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);
    const tampered = {
      ...snapshot,
      invoice: { ...snapshot.invoice, total: "999" },
    };

    expect(() => parseFiscalizationSnapshot(tampered, 1)).toThrow(FiscalizationSnapshotError);
  });

  it("rejects oversized persisted snapshots before validating their contents", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);
    const line = snapshot.invoice.lines[0]!;
    const oversized = {
      ...snapshot,
      invoice: {
        ...snapshot.invoice,
        lines: Array.from({ length: 10_000 }, () => line),
      },
    };

    expect(() => parseFiscalizationSnapshot(oversized, 1)).toThrow(
      "exceeds the supported storage size",
    );
  });

  it("rejects snapshots that cannot be safely serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => parseFiscalizationSnapshot(cyclic, 1)).toThrow(
      "stored fiscalization snapshot is not valid JSON",
    );
  });

  it("rejects unsupported snapshot versions", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);

    expect(() => parseFiscalizationSnapshot({ ...snapshot, schemaVersion: 2 }, 2)).toThrow(
      UnsupportedFiscalizationSnapshotVersionError,
    );
  });
});
