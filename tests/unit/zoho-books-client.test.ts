import { describe, expect, it, vi } from "vitest";
import type { ZohoBooksApiError } from "../../src/integrations/zoho/books-client.js";
import { ZohoBooksClient } from "../../src/integrations/zoho/books-client.js";

const invoiceId = "460000000012345";
const accessToken = "test-access-token";

function createClient(
  response: Response,
  options: {
    apiDomain?: string;
    scopes?: string;
  } = {},
) {
  const tokenProvider = {
    getAccessToken: vi.fn().mockResolvedValue({
      accessToken,
      apiDomain: options.apiDomain ?? "https://www.zohoapis.com",
      scopes: options.scopes ?? "ZohoBooks.invoices.READ",
    }),
  };

  const transport = vi.fn<typeof fetch>().mockResolvedValue(response);

  const client = new ZohoBooksClient({
    tokenProvider,
    organizationId: "test-organization-id",
    transport,
  });

  return { client, tokenProvider, transport };
}

describe("ZohoBooksClient", () => {
  it("retrieves an invoice and sends the expected authenticated request", async () => {
    const invoice = {
      invoice_id: invoiceId,
      invoice_number: "INV-001",
      customer_id: "customer-123",
      customer_name: "Example Customer",
      currency_code: "KES",
    };

    const { client, tokenProvider, transport } = createClient(
      new Response(JSON.stringify({ invoice }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.getInvoice(invoiceId);

    expect(result).toEqual({
      invoiceId,
      invoiceNumber: "INV-001",
      customerId: "customer-123",
      customerName: "Example Customer",
      currencyCode: "KES",
      source: invoice,
    });

    expect(tokenProvider.getAccessToken).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();

    const [url, request] = transport.mock.calls[0]!;

    const parsedUrl = new URL(String(url));

    expect(parsedUrl.origin).toBe("https://www.zohoapis.com");
    expect(parsedUrl.pathname).toBe(`/books/v3/invoices/${invoiceId}`);
    expect(parsedUrl.searchParams.get("organization_id")).toBe("test-organization-id");
    expect(request?.method).toBe("GET");
    expect(request?.headers).toMatchObject({
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: "application/json",
    });
  });

  it("rejects an unsuccessful HTTP response with its status", async () => {
    const { client, transport } = createClient(new Response("Unavailable", { status: 503 }));

    await expect(client.getInvoice(invoiceId)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 503,
    } satisfies Partial<ZohoBooksApiError>);

    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects invalid JSON", async () => {
    const { client } = createClient(new Response("not JSON", { status: 200 }));

    await expect(client.getInvoice(invoiceId)).rejects.toThrow(
      "Zoho Books returned invalid JSON for the invoice.",
    );
  });

  it("rejects a response without an invoice object", async () => {
    const { client } = createClient(new Response(JSON.stringify({ code: 0 }), { status: 200 }));

    await expect(client.getInvoice(invoiceId)).rejects.toThrow(
      "Zoho response does not contain a valid invoice.",
    );
  });

  it("rejects an invoice whose ID differs from the requested ID", async () => {
    const { client } = createClient(
      new Response(
        JSON.stringify({
          invoice: { invoice_id: "unexpected-invoice-id" },
        }),
        { status: 200 },
      ),
    );

    await expect(client.getInvoice(invoiceId)).rejects.toThrow(
      "Zoho returned an invoice with an unexpected ID.",
    );
  });

  it.each([{ invoice_id: "" }, { invoice_id: "   " }, {}])(
    "rejects an invoice with a missing or blank ID: %o",
    async (invoice) => {
      const { client } = createClient(new Response(JSON.stringify({ invoice }), { status: 200 }));

      await expect(client.getInvoice(invoiceId)).rejects.toThrow(
        "Zoho invoice response is missing a valid invoice ID.",
      );
    },
  );

  it("rejects a token without the invoice-read scope", async () => {
    const { client, transport } = createClient(
      new Response(JSON.stringify({ invoice: { invoice_id: invoiceId } }), {
        status: 200,
      }),
      { scopes: "ZohoBooks.contacts.READ" },
    );

    await expect(client.getInvoice(invoiceId)).rejects.toThrow(
      "The connected Zoho account has not granted ZohoBooks.invoices.READ.",
    );

    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "http://www.zohoapis.com",
    "https://user:password@www.zohoapis.com",
    "https://www.zohoapis.com/unexpected-path",
    "https://attacker.example",
    "https://www.zohoapis.com.attacker.example",
    "https://www.zohoapis.com:8443",
  ])("rejects an unsafe API domain: %s", async (apiDomain) => {
    const { client, transport } = createClient(
      new Response(JSON.stringify({ invoice: { invoice_id: invoiceId } }), {
        status: 200,
      }),
      { apiDomain },
    );

    await expect(client.getInvoice(invoiceId)).rejects.toThrow(
      "Zoho returned an invalid API domain.",
    );

    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects a blank invoice ID before requesting a token", async () => {
    const { client, tokenProvider, transport } = createClient(new Response("{}", { status: 200 }));

    await expect(client.getInvoice("  ")).rejects.toThrow("Zoho invoice ID is required.");

    expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes invalid optional metadata to null while preserving the source", async () => {
    const invoice = {
      invoice_id: invoiceId,
      invoice_number: 123,
      customer_id: null,
      customer_name: { unexpected: "object" },
      currency_code: "   ",
    };

    const { client } = createClient(
      new Response(JSON.stringify({ invoice }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await client.getInvoice(invoiceId);

    expect(result).toEqual({
      invoiceId,
      invoiceNumber: null,
      customerId: null,
      customerName: null,
      currencyCode: null,
      source: invoice,
    });
  });
});
