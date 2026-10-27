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

  it("rejects unsupported snapshot versions", async () => {
    const snapshot = await makeFiscalizationSnapshot(invoice);

    expect(() => parseFiscalizationSnapshot({ ...snapshot, schemaVersion: 2 }, 2)).toThrow(
      UnsupportedFiscalizationSnapshotVersionError,
    );
  });
});
