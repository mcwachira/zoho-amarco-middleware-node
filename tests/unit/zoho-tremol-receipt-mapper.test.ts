import { describe, expect, it } from "vitest";
import {
  mapZohoInvoiceToTremolPlan,
  type ZohoTremolMappingInput,
} from "../../src/infrastructure/device/zoho-tremol-receipt-mapper.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";

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

const validInput: ZohoTremolMappingInput = {
  invoice,
  customer: {
    companyName: "Example Customer Ltd",
    clientPin: "P051234567X",
    headquarters: "Diani",
    address: "Main Road",
    postalCodeAndCity: "80400 Ukunda",
    traderSystemInvoiceNumber: "INV-1001",
  },
  lineMetadata: [
    {
      sourceLineId: "line-1",
      vatClass: "A",
      measureUnit: "EA",
      hsCode: "1234.56.78",
      hsName: "Consulting",
      vatGroupRate: "0",
    },
  ],
};

describe("mapZohoInvoiceToTremolPlan", () => {
  it("returns a non-executable plan for complete explicit metadata", () => {
    const result = mapZohoInvoiceToTremolPlan(validInput);

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.plan.executable).toBe(false);
      expect(result.plan.commands).toHaveLength(3);
      expect(result.plan.commands[1]).toContain("SellPLUfromExtDB(");
    }
  });

  it("rejects invoice lines with missing fiscal metadata", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      lineMetadata: [],
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Explicit fiscal metadata is required for this invoice line.",
          }),
        ]),
      );
    }
  });

  it("rejects metadata for an unrelated invoice line", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      lineMetadata: [
        {
          ...validInput.lineMetadata[0]!,
          sourceLineId: "another-line",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects duplicate metadata for the same invoice line", () => {
    const metadata = validInput.lineMetadata[0]!;

    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      lineMetadata: [metadata, metadata],
    });

    expect(result.success).toBe(false);
  });

  it("does not guess unsupported VAT classes", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      lineMetadata: [
        {
          ...validInput.lineMetadata[0]!,
          vatClass: "B",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects invoice lines without a stable source line ID", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      invoice: {
        ...invoice,
        lines: [{ ...invoice.lines[0]!, sourceLineId: null }],
      },
    });

    expect(result.success).toBe(false);
  });
  it("rejects whitespace-only invoice line IDs", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      invoice: {
        ...invoice,
        lines: [{ ...invoice.lines[0]!, sourceLineId: "   " }],
      },
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "invoice.lines[0].sourceLineId",
            message: "The Zoho invoice line has no stable line ID.",
          }),
        ]),
      );
    }
  });

  it("matches invoice and fiscal metadata IDs after trimming whitespace", () => {
    const result = mapZohoInvoiceToTremolPlan({
      ...validInput,
      invoice: {
        ...invoice,
        lines: [{ ...invoice.lines[0]!, sourceLineId: " line-1 " }],
      },
    });

    expect(result.success).toBe(true);
  });
});
