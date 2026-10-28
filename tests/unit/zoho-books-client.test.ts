import { describe, expect, it, vi } from "vitest";
import type { ZohoBooksApiError } from "../../src/integrations/zoho/books-client.js";
import {
  ZohoBooksAuthorizationError,
  ZohoBooksClient,
  isValidZohoBooksIdentifier,
} from "../../src/integrations/zoho/books-client.js";
import { runWithCorrelationId } from "../../src/observability/request-context.js";

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
  it("uses its opaque Zoho identifier policy for live invoice IDs", () => {
    expect(isValidZohoBooksIdentifier("invoice_fixture-2026_10")).toBe(true);
    expect(isValidZohoBooksIdentifier("-invoice-id")).toBe(false);
    expect(isValidZohoBooksIdentifier("i".repeat(129))).toBe(false);
  });

  it("accepts the documented UAE Books API origin", async () => {
    const { client, transport } = createClient(
      new Response(JSON.stringify({ invoice: { invoice_id: invoiceId } }), { status: 200 }),
      { apiDomain: "https://www.zohoapis.ae" },
    );
    await client.getInvoice(invoiceId);
    expect(transport).toHaveBeenCalledOnce();
    expect(new URL(String(transport.mock.calls[0]?.[0])).origin).toBe("https://www.zohoapis.ae");
  });

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

    const result = await runWithCorrelationId("trace-zoho-42", () => client.getInvoice(invoiceId));

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
      "X-Correlation-ID": "trace-zoho-42",
    });
  });

  it("updates exactly one configured invoice custom field without changing invoice totals", async () => {
    const { client, transport, tokenProvider } = createClient(
      new Response(JSON.stringify({ code: 0, message: "success" }), { status: 200 }),
      { scopes: "ZohoBooks.invoices.READ,ZohoBooks.invoices.UPDATE" },
    );

    await client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized");

    expect(tokenProvider.getAccessToken).toHaveBeenCalledOnce();
    expect(client.getOrganizationId()).toBe("test-organization-id");
    const [url, request] = transport.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(`/books/v3/invoice/${invoiceId}/customfields`);
    expect(new URL(String(url)).searchParams.get("organization_id")).toBe("test-organization-id");
    expect(request?.method).toBe("PUT");
    expect(request?.headers).toMatchObject({
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      customfield_id: "460000000099001",
      value: "Fiscalized",
    });
  });

  it("requires the invoice update scope and sanitizes refresh failures", async () => {
    const { client, transport } = createClient(
      new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    );
    await expect(
      client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized"),
    ).rejects.toMatchObject({ category: "authorization", outcome: "definitive_failure" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authorization", "definitive_failure"],
    [403, "authorization", "definitive_failure"],
    [404, "not_found", "definitive_failure"],
    [422, "validation", "definitive_failure"],
    [503, "server_error", "outcome_unknown"],
  ] as const)("classifies Zoho update HTTP %i without retry", async (status, category, outcome) => {
    const { client, transport } = createClient(new Response("{}", { status }), {
      scopes: "ZohoBooks.invoices.UPDATE",
    });
    await expect(
      client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized"),
    ).rejects.toMatchObject({ category, outcome, httpStatus: status });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("retries a definitive rate-limit response within the configured bound", async () => {
    const { client, transport } = createClient(new Response("{}", { status: 429 }), {
      scopes: "ZohoBooks.invoices.UPDATE",
    });
    transport
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(Response.json({ code: 0 }));
    await client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized");
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("treats a network timeout and malformed success response as uncertain", async () => {
    const network = createClient(Response.json({ code: 0 }), {
      scopes: "ZohoBooks.invoices.UPDATE",
    });
    network.transport.mockRejectedValue(new TypeError("socket timeout"));
    await expect(
      network.client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized"),
    ).rejects.toMatchObject({ category: "network_error", outcome: "outcome_unknown" });
    expect(network.transport).toHaveBeenCalledOnce();

    const malformed = createClient(new Response("not-json", { status: 200 }), {
      scopes: "ZohoBooks.invoices.UPDATE",
    });
    await expect(
      malformed.client.updateInvoiceCustomField(invoiceId, "460000000099001", "Fiscalized"),
    ).rejects.toMatchObject({ category: "malformed_response", outcome: "outcome_unknown" });
  });

  it("rejects an unsuccessful HTTP response with its status", async () => {
    const { client, transport } = createClient(new Response("Unavailable", { status: 503 }));

    await expect(client.getInvoice(invoiceId)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 503,
    } satisfies Partial<ZohoBooksApiError>);

    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("retains only Zoho's numeric error code from a bounded error response", async () => {
    const { client } = createClient(
      new Response(
        JSON.stringify({ code: 1002, message: "Invoice does not exist", access_token: "secret" }),
        { status: 404 },
      ),
    );

    let caught: unknown;
    try {
      await client.getInvoice(invoiceId);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ name: "ZohoBooksApiError", status: 404, apiCode: 1002 });
    expect(caught).not.toHaveProperty("access_token");
    expect((caught as Error).message).not.toContain("Invoice does not exist");
    expect((caught as Error).message).not.toContain("secret");
  });

  it("does not infer an invoice-specific provider error from an unstructured 404", async () => {
    const { client } = createClient(new Response("not JSON", { status: 404 }));
    await expect(client.getInvoice(invoiceId)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 404,
      apiCode: undefined,
    });
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

    await expect(client.getInvoice(invoiceId)).rejects.toBeInstanceOf(ZohoBooksAuthorizationError);

    expect(transport).not.toHaveBeenCalled();
  });

  it("classifies missing or failed token refresh without exposing credential errors", async () => {
    const tokenProvider = {
      getAccessToken: vi.fn().mockRejectedValue(new Error("refresh token secret was rejected")),
    };
    const transport = vi.fn<typeof fetch>();
    const client = new ZohoBooksClient({
      tokenProvider,
      organizationId: "test-organization-id",
      transport,
    });

    const request = client.getInvoice(invoiceId);
    const error = await request.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ZohoBooksAuthorizationError);
    expect(error).toMatchObject({
      message: "Zoho authorization is unavailable or lacks the required invoice-read permission.",
    });
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

  it.each(["invoice/other", "invoice?other", "   ", "x".repeat(129)])(
    "rejects malformed invoice identifiers before requesting a token: %s",
    async (invalidInvoiceId) => {
      const { client, tokenProvider, transport } = createClient(
        new Response("{}", { status: 200 }),
      );

      await expect(client.getInvoice(invalidInvoiceId)).rejects.toThrow(
        "A valid Zoho invoice ID is required.",
      );
      expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each(["", " organization/other", "x".repeat(129)])(
    "rejects malformed organization identifiers: %s",
    (organizationId) => {
      expect(
        () =>
          new ZohoBooksClient({
            tokenProvider: {
              getAccessToken: vi.fn(),
            },
            organizationId,
          }),
      ).toThrow("A valid Zoho organization ID is required.");
    },
  );

  it("cancels an active HTTP request without retrying it", async () => {
    let requestSignal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal as AbortSignal;
          requestSignal.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        }),
    );
    const client = new ZohoBooksClient({
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken,
          apiDomain: "https://www.zohoapis.com",
          scopes: "ZohoBooks.invoices.READ",
        }),
      },
      organizationId: "test-organization-id",
      transport,
    });
    const controller = new AbortController();
    const request = client.getInvoice(invoiceId, controller.signal);

    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).toHaveBeenCalledOnce();
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

  it("preserves monetary JSON number lexemes without parsing them as binary floats", async () => {
    const responseText =
      `{"invoice":{"invoice_id":"${invoiceId}","invoice_number":"INV-001","customer_id":"customer-123",` +
      `"customer_name":"Example Customer","currency_code":"KES","line_items":[{"line_item_id":"line-1",` +
      `"item_id":"item-1","quantity":1,"rate":0.10000000000000001,"item_total":0.10000000000000001}],` +
      `"sub_total":0.10000000000000001,"tax_total":0,"total":0.10000000000000001}}`;
    const { client } = createClient(new Response(responseText, { status: 200 }));

    const result = await client.getInvoice(invoiceId);
    const lineItems = result.source["line_items"] as Array<Record<string, unknown>>;

    expect(lineItems[0]?.["rate"]).toBe("0.10000000000000001");
    expect(result.source["total"]).toBe("0.10000000000000001");
  });

  it("retrieves a validated invoice-list page using Zoho pagination parameters", async () => {
    const body =
      '{"code":0,"invoices":[{"invoice_id":460000000012345678,"invoice_number":"INV-001"},' +
      '{"invoice_id":"460000000012345679","invoice_number":"INV-002"}],' +
      '"page_context":{"page":1,"per_page":2,"has_more_page":true}}';
    const { client, transport } = createClient(new Response(body, { status: 200 }));

    await expect(client.listInvoicesPage(1, 2)).resolves.toEqual({
      page: 1,
      invoices: [
        { invoiceId: "460000000012345678", invoiceNumber: "INV-001" },
        { invoiceId: "460000000012345679", invoiceNumber: "INV-002" },
      ],
      hasMore: true,
    });

    const parsedUrl = new URL(String(transport.mock.calls[0]?.[0]));
    expect(parsedUrl.pathname).toBe("/books/v3/invoices");
    expect(parsedUrl.searchParams.get("organization_id")).toBe("test-organization-id");
    expect(parsedUrl.searchParams.get("page")).toBe("1");
    expect(parsedUrl.searchParams.get("per_page")).toBe("2");
  });

  it("rejects incomplete or malformed invoice pagination metadata", async () => {
    const { client } = createClient(
      new Response(JSON.stringify({ invoices: [{ invoice_id: "invoice-1" }] }), { status: 200 }),
    );

    await expect(client.listInvoicesPage(1)).rejects.toThrow(
      "Zoho Books returned an incomplete invoice-list page.",
    );
  });

  it("rejects invalid invoice page arguments before making a request", async () => {
    const { client, transport } = createClient(new Response("{}", { status: 200 }));

    await expect(client.listInvoicesPage(0)).rejects.toThrow(
      "Invoice page must be a positive integer.",
    );
    await expect(client.listInvoicesPage(1, 201)).rejects.toThrow(
      "Invoice page size must be between 1 and 200.",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("retries rate-limited requests using the Retry-After delay", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [],
            page_context: { page: 1, per_page: 200, has_more_page: false },
          }),
          { status: 200 },
        ),
      );
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new ZohoBooksClient({
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken,
          apiDomain: "https://www.zohoapis.com",
          scopes: "ZohoBooks.invoices.READ",
        }),
      },
      organizationId: "test-organization-id",
      transport,
      sleep,
      maxRetryDelayMs: 5_000,
    });

    await expect(client.listInvoicesPage(1)).resolves.toMatchObject({
      invoices: [],
      hasMore: false,
    });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("retries transient server failures with bounded backoff", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network detail must not be exposed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            invoices: [],
            page_context: { page: 1, per_page: 200, has_more_page: false },
          }),
          { status: 200 },
        ),
      );
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new ZohoBooksClient({
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken,
          apiDomain: "https://www.zohoapis.com",
          scopes: "ZohoBooks.invoices.READ",
        }),
      },
      organizationId: "test-organization-id",
      transport,
      sleep,
      retryBaseDelayMs: 100,
      maxRetryDelayMs: 120,
    });

    await expect(client.listInvoicesPage(1)).resolves.toMatchObject({ hasMore: false });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("does not retry a rate-limit response when Retry-After exceeds the delay bound", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }),
      );
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new ZohoBooksClient({
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken,
          apiDomain: "https://www.zohoapis.com",
          scopes: "ZohoBooks.invoices.READ",
        }),
      },
      organizationId: "test-organization-id",
      transport,
      sleep,
      maxRetryDelayMs: 1_000,
    });

    await expect(client.listInvoicesPage(1)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 429,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry expired-auth responses", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const client = new ZohoBooksClient({
      tokenProvider: {
        getAccessToken: vi.fn().mockResolvedValue({
          accessToken,
          apiDomain: "https://www.zohoapis.com",
          scopes: "ZohoBooks.invoices.READ",
        }),
      },
      organizationId: "test-organization-id",
      transport,
      sleep,
    });

    await expect(client.listInvoicesPage(1)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 401,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects a Zoho API error envelope even when HTTP succeeds", async () => {
    const { client, transport } = createClient(
      new Response(JSON.stringify({ code: 57, message: "provider detail" }), { status: 200 }),
    );

    await expect(client.listInvoicesPage(1)).rejects.toMatchObject({
      name: "ZohoBooksApiError",
      status: 200,
      apiCode: 57,
      message: "Zoho Books rejected the invoice request.",
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  describe("getInvoicePayments", () => {
    it("retrieves payments for an invoice", async () => {
      const payments = {
        payments: [
          {
            payment_id: "pay-1",
            payment_number: "PAY-001",
            payment_mode: "Cash",
            amount: 100.125,
            date: "2026-10-27",
            reference_number: "REF-001",
            description: "Payment for invoice",
          },
        ],
        page_context: { page: 1, per_page: 200, has_more_page: false },
      };

      const { client, transport } = createClient(
        new Response(JSON.stringify(payments), { status: 200 }),
      );

      const result = await client.getInvoicePayments(invoiceId);

      expect(result).toEqual({
        page: 1,
        payments: [
          {
            paymentId: "pay-1",
            paymentNumber: "PAY-001",
            paymentMode: "Cash",
            amount: "100.125",
            date: "2026-10-27",
            referenceNumber: "REF-001",
            description: "Payment for invoice",
            source: { ...payments.payments[0], amount: "100.125" },
          },
        ],
        hasMore: false,
      });

      const [url] = transport.mock.calls[0]!;
      const parsedUrl = new URL(String(url));
      expect(parsedUrl.pathname).toBe(`/books/v3/invoices/${invoiceId}/payments`);
      expect(parsedUrl.searchParams.get("organization_id")).toBe("test-organization-id");
      expect(parsedUrl.searchParams.get("page")).toBe("1");
      expect(parsedUrl.searchParams.get("per_page")).toBe("200");
    });

    it("preserves numeric payment identifier and amount lexemes", async () => {
      const body =
        '{"code":0,"payments":[{"payment_id":9007199254740993,"amount":0.10000000000000001}],' +
        '"page_context":{"page":2,"per_page":200,"has_more_page":false}}';
      const { client } = createClient(new Response(body, { status: 200 }));

      await expect(client.getInvoicePayments(invoiceId, undefined, 2)).resolves.toMatchObject({
        page: 2,
        payments: [{ paymentId: "9007199254740993", amount: "0.10000000000000001" }],
      });
    });

    it("rejects an invalid payments response", async () => {
      const { client } = createClient(
        new Response(JSON.stringify({ payments: [] }), { status: 200 }),
      );

      await expect(client.getInvoicePayments(invoiceId)).rejects.toThrow(
        "Zoho Books returned an incomplete payment-list page.",
      );
    });

    it("rejects a blank invoice ID before requesting a token", async () => {
      const { client, tokenProvider, transport } = createClient(
        new Response("{}", { status: 200 }),
      );

      await expect(client.getInvoicePayments("  ")).rejects.toThrow("Zoho invoice ID is required.");

      expect(tokenProvider.getAccessToken).not.toHaveBeenCalled();
      expect(transport).not.toHaveBeenCalled();
    });
  });
});
