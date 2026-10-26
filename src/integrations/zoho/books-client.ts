/**
 * Minimal Zoho Books invoice client.
 *
 * This integration retrieves invoices only. It does not fiscalize them,
 * modify Zoho records, or communicate with the Tremol device.
 */

import { parseZohoBooksApiDomain } from "./api-domain.js";

export interface ZohoAccessTokenProvider {
  getAccessToken(): Promise<{
    accessToken: string;
    apiDomain: string;
    scopes: string;
  }>;
}

export type ZohoBooksTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ZohoInvoice {
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly currencyCode: string | null;
  /**
   * Keep the original validated invoice object available for the next
   * mapping step. Mapping and fiscal calculations belong elsewhere.
   */
  readonly source: Readonly<Record<string, unknown>>;
}

export interface ZohoBooksClientOptions {
  readonly tokenProvider: ZohoAccessTokenProvider;
  readonly organizationId: string;
  readonly transport?: ZohoBooksTransport;
}

export class ZohoBooksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ZohoBooksApiError";
  }
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Zoho invoice response is missing a valid ${field}.`);
  }

  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validateApiDomain(value: string): URL {
  const url = parseZohoBooksApiDomain(value);

  if (url === null) {
    throw new Error("Zoho returned an invalid API domain.");
  }

  return url;
}

function parseInvoiceResponse(value: unknown, requestedInvoiceId: string): ZohoInvoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Zoho returned an invalid invoice response.");
  }

  const envelope = value as Record<string, unknown>;
  const invoiceValue = envelope["invoice"];

  if (typeof invoiceValue !== "object" || invoiceValue === null || Array.isArray(invoiceValue)) {
    throw new Error("Zoho response does not contain a valid invoice.");
  }

  const invoice = invoiceValue as Record<string, unknown>;
  const invoiceId = requiredText(invoice["invoice_id"], "invoice ID");

  if (invoiceId !== requestedInvoiceId) {
    throw new Error("Zoho returned an invoice with an unexpected ID.");
  }

  return {
    invoiceId,
    invoiceNumber: optionalText(invoice["invoice_number"]),
    customerId: optionalText(invoice["customer_id"]),
    customerName: optionalText(invoice["customer_name"]),
    currencyCode: optionalText(invoice["currency_code"]),
    source: invoice,
  };
}

export class ZohoBooksClient {
  private readonly tokenProvider: ZohoAccessTokenProvider;
  private readonly organizationId: string;
  private readonly transport: ZohoBooksTransport;

  constructor(options: ZohoBooksClientOptions) {
    if (!options.organizationId.trim()) {
      throw new Error("Zoho Books organization ID is required.");
    }

    this.tokenProvider = options.tokenProvider;
    this.organizationId = options.organizationId.trim();
    this.transport = options.transport ?? fetch;
  }

  /**
   * Fetches one invoice from Zoho Books.
   *
   * This method never returns or logs the OAuth access token.
   */
  async getInvoice(invoiceIdInput: string): Promise<ZohoInvoice> {
    const invoiceId = invoiceIdInput.trim();

    if (!invoiceId) {
      throw new Error("Zoho invoice ID is required.");
    }

    const token = await this.tokenProvider.getAccessToken();

    if (!token.accessToken.trim()) {
      throw new Error("Zoho access token provider returned an empty token.");
    }

    if (!token.scopes.split(",").some((scope) => scope.trim() === "ZohoBooks.invoices.READ")) {
      throw new Error("The connected Zoho account has not granted ZohoBooks.invoices.READ.");
    }

    const apiDomain = validateApiDomain(token.apiDomain);
    const invoiceUrl = new URL(`/books/v3/invoices/${encodeURIComponent(invoiceId)}`, apiDomain);

    invoiceUrl.searchParams.set("organization_id", this.organizationId);

    const response = await this.transport(invoiceUrl, {
      method: "GET",
      headers: {
        Authorization: `Zoho-oauthtoken ${token.accessToken}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new ZohoBooksApiError(
        `Zoho Books invoice request failed with HTTP status ${response.status}.`,
        response.status,
      );
    }

    let responseBody: unknown;

    try {
      responseBody = await response.json();
    } catch {
      throw new Error("Zoho Books returned invalid JSON for the invoice.");
    }

    return parseInvoiceResponse(responseBody, invoiceId);
  }
}
