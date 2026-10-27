import { describe, expect, it } from "vitest";
import type { ZohoInvoice } from "../../src/integrations/zoho/books-client.js";
import { mapZohoInvoice } from "../../src/application/zoho/zoho-invoice-mapper.js";

const invoiceId = "460000000012345";

function createInvoice(sourceOverrides: Record<string, unknown> = {}): ZohoInvoice {
  const source = {
    invoice_id: invoiceId,
    currency_code: "KES",
    line_items: [
      {
        line_item_id: "line-1",
        item_id: "item-1",
        name: "Example product",
        description: "A test product",
        quantity: 2,
        rate: 150,
        item_total: 300,
        tax_id: "tax-1",
        tax_name: "Source tax",
        tax_type: "tax",
        tax_percentage: 16,
      },
    ],
    sub_total: 300,
    tax_total: 48,
    total: 348,
    ...sourceOverrides,
  };

  return {
    invoiceId,
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Example Customer",
    currencyCode: "KES",
    source,
  };
}

describe("mapZohoInvoice", () => {
  it("maps a valid invoice while preserving financial values", () => {
    const result = mapZohoInvoice(createInvoice());

    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error("Expected a valid invoice candidate.");
    }

    expect(result.candidate).toEqual({
      zohoInvoiceId: invoiceId,
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
    });
  });

  it("preserves decimal strings without converting them to floating-point numbers", () => {
    const result = mapZohoInvoice(
      createInvoice({
        line_items: [
          {
            quantity: "1.25",
            rate: "19.90",
            item_total: "24.875",
          },
        ],
        sub_total: "24.875",
        tax_total: "0.00",
        total: "24.875",
      }),
    );

    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error("Expected a valid invoice candidate.");
    }

    expect(result.candidate.lines[0]?.quantity).toBe("1.25");
    expect(result.candidate.lines[0]?.unitPrice).toBe("19.90");
    expect(result.candidate.subtotal).toBe("24.875");
    expect(result.candidate.taxTotal).toBe("0.00");
  });

  it("does not infer receipt payment data from invoice totals or generic paid fields", () => {
    const result = mapZohoInvoice(
      createInvoice({
        status: "paid",
        payment_mode: "cash",
        amount_paid: 348,
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected a valid invoice candidate.");
    }

    expect(result.candidate.total).toBe("348");
    expect(result.candidate).not.toHaveProperty("payment");
    expect(result.candidate).not.toHaveProperty("paymentStatus");
    expect(result.candidate).not.toHaveProperty("paymentMethod");
  });

  it("rejects currency metadata that differs from the invoice source", () => {
    const result = mapZohoInvoice(
      createInvoice({
        currency_code: "USD",
      }),
    );

    expect(result).toEqual({
      success: false,
      errors: [
        {
          field: "currency_code",
          message:
            "The currency code from retrieved invoice metadata does not match the invoice source currency code.",
        },
      ],
    });
  });

  it("rejects missing top-level currency metadata", () => {
    const invoice = createInvoice();

    const result = mapZohoInvoice({
      ...invoice,
      currencyCode: null,
    });

    expect(result).toEqual({
      success: false,
      errors: [
        {
          field: "currency_code",
          message:
            "The currency code from retrieved invoice metadata does not match the invoice source currency code.",
        },
      ],
    });
  });

  it.each([
    ["missing currency", { currency_code: "" }],
    ["missing line items", { line_items: [] }],
    ["missing subtotal", { sub_total: undefined }],
    ["invalid invoice total", { total: "not-a-number" }],
    ["invalid line quantity", { line_items: [{ quantity: true, rate: 10, item_total: 10 }] }],
    ["invalid line price", { line_items: [{ quantity: 1, rate: "unknown", item_total: 10 }] }],
    [
      "invalid tax percentage",
      { line_items: [{ quantity: 1, rate: 10, item_total: 10, tax_percentage: "unknown" }] },
    ],
  ])("rejects an invoice with %s", (_description, overrides) => {
    const result = mapZohoInvoice(createInvoice(overrides));

    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected invoice validation to fail.");
    }

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a source invoice ID that differs from the retrieved invoice ID", () => {
    const result = mapZohoInvoice(createInvoice({ invoice_id: "different-invoice" }));

    expect(result).toEqual({
      success: false,
      errors: [
        {
          field: "invoice_id",
          message: "The source invoice ID does not match the retrieved invoice ID.",
        },
      ],
    });
  });

  it("does not require optional customer and line description fields", () => {
    const invoice = createInvoice({
      line_items: [
        {
          quantity: 1,
          rate: 10,
          item_total: 10,
        },
      ],
      sub_total: 10,
      tax_total: 0,
      total: 10,
    });

    const result = mapZohoInvoice({
      ...invoice,
      customerId: null,
      customerName: null,
    });

    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error("Expected a valid invoice candidate.");
    }

    expect(result.candidate.customerId).toBeNull();
    expect(result.candidate.customerName).toBeNull();
    expect(result.candidate.lines[0]?.description).toBeNull();
    expect(result.candidate.lines[0]?.taxPercentage).toBeNull();
  });

  it("rejects invalid optional tax metadata", () => {
    const result = mapZohoInvoice(
      createInvoice({
        line_items: [
          {
            quantity: 1,
            rate: 10,
            item_total: 10,
            tax_id: { unexpected: "object" },
          },
        ],
        sub_total: 10,
        tax_total: 0,
        total: 10,
      }),
    );

    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected invalid tax metadata to fail validation.");
    }

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        field: "line_items.0.tax_id",
      }),
    );
  });
});
