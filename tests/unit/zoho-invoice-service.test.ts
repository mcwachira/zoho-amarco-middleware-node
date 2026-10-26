import { describe, expect, it, vi } from "vitest";
import { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import type { ZohoInvoice } from "../../src/integrations/zoho/books-client.js";

const invoiceId = "460000000012345";

function createInvoice(sourceOverrides: Record<string, unknown> = {}): ZohoInvoice {
  return {
    invoiceId,
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Example Customer",
    currencyCode: "KES",
    source: {
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
    },
  };
}

describe("ZohoInvoiceService", () => {
  it("retrieves and maps a valid invoice", async () => {
    const invoice = createInvoice();
    const getInvoice = vi.fn().mockResolvedValue(invoice);
    const service = new ZohoInvoiceService({ getInvoice });

    const result = await service.getFiscalInvoiceCandidate(invoiceId);

    expect(getInvoice).toHaveBeenCalledOnce();
    expect(getInvoice).toHaveBeenCalledWith(invoiceId);
    expect(result.success).toBe(true);

    if (!result.success) {
      throw new Error("Expected a valid invoice candidate.");
    }

    expect(result.candidate).toMatchObject({
      zohoInvoiceId: invoiceId,
      invoiceNumber: "INV-001",
      currencyCode: "KES",
      subtotal: "300",
      taxTotal: "48",
      total: "348",
    });
  });

  it("returns mapping errors when the retrieved invoice is invalid", async () => {
    const invoice = createInvoice({ currency_code: "" });
    const getInvoice = vi.fn().mockResolvedValue(invoice);
    const service = new ZohoInvoiceService({ getInvoice });

    const result = await service.getFiscalInvoiceCandidate(invoiceId);

    expect(getInvoice).toHaveBeenCalledWith(invoiceId);
    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected invoice mapping to fail.");
    }

    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "currency_code" })]),
    );
  });

  it("propagates invoice retrieval errors to the caller", async () => {
    const upstreamError = new Error("Zoho Books request failed");
    const getInvoice = vi.fn().mockRejectedValue(upstreamError);
    const service = new ZohoInvoiceService({ getInvoice });

    await expect(service.getFiscalInvoiceCandidate(invoiceId)).rejects.toBe(upstreamError);

    expect(getInvoice).toHaveBeenCalledOnce();
    expect(getInvoice).toHaveBeenCalledWith(invoiceId);
  });
});
