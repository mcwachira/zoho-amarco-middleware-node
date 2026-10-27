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

export interface ZohoInvoiceSummary {
  readonly invoiceId: string;
  readonly invoiceNumber: string | null;
}

export interface ZohoInvoiceListPage {
  readonly page: number;
  readonly invoices: readonly ZohoInvoiceSummary[];
  readonly hasMore: boolean;
}

export interface ZohoBooksClientOptions {
  readonly tokenProvider: ZohoAccessTokenProvider;
  readonly organizationId: string;
  readonly transport?: ZohoBooksTransport;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class ZohoBooksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly apiCode?: number,
  ) {
    super(message);
    this.name = "ZohoBooksApiError";
  }
}

export class ZohoBooksTransportError extends Error {
  constructor() {
    super("Zoho Books request failed before a response was received.");
    this.name = "ZohoBooksTransportError";
  }
}

const MAX_INVOICE_PAGE_SIZE = 200;

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

function preserveJsonNumberLexemes(json: string): string {
  const decimalFields = new Set([
    "quantity",
    "rate",
    "item_total",
    "sub_total",
    "tax_total",
    "total",
    "tax_percentage",
  ]);
  const identifierFields = new Set([
    "invoice_id",
    "customer_id",
    "item_id",
    "line_item_id",
    "organization_id",
    "tax_id",
  ]);
  let result = "";
  let pendingKey: string | null = null;

  for (let index = 0; index < json.length; index += 1) {
    const character = json[index]!;

    if (character === '"') {
      const start = index;
      let escaped = false;
      index += 1;
      while (index < json.length) {
        const current = json[index]!;
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === '"') {
          break;
        }
        index += 1;
      }
      const token = json.slice(start, index + 1);
      result += token;
      let next = index + 1;
      while (next < json.length && /\s/.test(json[next]!)) {
        next += 1;
      }
      if (json[next] === ":") {
        try {
          const key: unknown = JSON.parse(token);
          pendingKey = typeof key === "string" ? key : null;
        } catch {
          pendingKey = null;
        }
      } else {
        pendingKey = null;
      }
      continue;
    }

    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      while (index + 1 < json.length && !/[\s,\]}]/.test(json[index + 1]!)) {
        index += 1;
      }
      const token = json.slice(start, index + 1);
      if (
        pendingKey !== null &&
        (decimalFields.has(pendingKey) || identifierFields.has(pendingKey)) &&
        /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)
      ) {
        result += JSON.stringify(token);
      } else {
        result += token;
      }
      pendingKey = null;
      continue;
    }

    if (!/\s/.test(character) && character !== ":") {
      pendingKey = null;
    }
    result += character;
  }

  return result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSuccessfulApiEnvelope(value: Record<string, unknown>): void {
  const code = value["code"];
  if (code === undefined) {
    return;
  }

  if (typeof code !== "number" || !Number.isSafeInteger(code)) {
    throw new Error("Zoho Books returned an invalid API response code.");
  }

  if (code !== 0) {
    throw new ZohoBooksApiError("Zoho Books rejected the invoice request.", 200, code);
  }
}

function parseInvoiceListPage(value: unknown, page: number): ZohoInvoiceListPage {
  if (!isRecord(value)) {
    throw new Error("Zoho Books returned an invalid invoice-list response.");
  }

  assertSuccessfulApiEnvelope(value);

  const invoiceValues = value["invoices"];
  const pageContext = value["page_context"];
  if (!Array.isArray(invoiceValues) || !isRecord(pageContext)) {
    throw new Error("Zoho Books returned an incomplete invoice-list page.");
  }

  const hasMore = pageContext["has_more_page"];
  if (typeof hasMore !== "boolean") {
    throw new Error("Zoho Books invoice-list page is missing pagination metadata.");
  }

  const invoices = invoiceValues.map((invoiceValue): ZohoInvoiceSummary => {
    if (!isRecord(invoiceValue)) {
      throw new Error("Zoho Books returned an invalid invoice summary.");
    }

    return {
      invoiceId: requiredText(invoiceValue["invoice_id"], "invoice ID"),
      invoiceNumber: optionalText(invoiceValue["invoice_number"]),
    };
  });

  return { page, invoices, hasMore };
}

function parseRetryAfter(response: Response, now: number): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (/^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(seconds)) {
    return Math.max(0, Math.ceil(seconds * 1000));
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export class ZohoBooksClient {
  private readonly tokenProvider: ZohoAccessTokenProvider;
  private readonly organizationId: string;
  private readonly transport: ZohoBooksTransport;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: ZohoBooksClientOptions) {
    if (!options.organizationId.trim()) {
      throw new Error("Zoho Books organization ID is required.");
    }

    this.tokenProvider = options.tokenProvider;
    this.organizationId = options.organizationId.trim();
    this.transport = options.transport ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    if (!Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 5) {
      throw new Error("maxRetries must be an integer between 0 and 5.");
    }
    if (!Number.isSafeInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs < 0) {
      throw new Error("retryBaseDelayMs must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(this.maxRetryDelayMs) || this.maxRetryDelayMs < 0) {
      throw new Error("maxRetryDelayMs must be a non-negative integer.");
    }
  }

  async listInvoicesPage(
    pageInput: number,
    perPageInput = MAX_INVOICE_PAGE_SIZE,
  ): Promise<ZohoInvoiceListPage> {
    if (!Number.isSafeInteger(pageInput) || pageInput < 1) {
      throw new Error("Invoice page must be a positive integer.");
    }
    if (
      !Number.isSafeInteger(perPageInput) ||
      perPageInput < 1 ||
      perPageInput > MAX_INVOICE_PAGE_SIZE
    ) {
      throw new Error(`Invoice page size must be between 1 and ${MAX_INVOICE_PAGE_SIZE}.`);
    }

    const token = await this.getAccessToken();
    const url = this.createInvoicesUrl(token.apiDomain);
    url.searchParams.set("page", String(pageInput));
    url.searchParams.set("per_page", String(perPageInput));

    const response = await this.request(url, token.accessToken);
    const responseBody = await this.readJson(response, "invoice list");
    return parseInvoiceListPage(responseBody, pageInput);
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

    const token = await this.getAccessToken();
    const invoiceUrl = new URL(
      `/books/v3/invoices/${encodeURIComponent(invoiceId)}`,
      token.apiDomain,
    );
    invoiceUrl.searchParams.set("organization_id", this.organizationId);

    const response = await this.request(invoiceUrl, token.accessToken);
    const responseBody = await this.readJson(response, "invoice");
    if (!isRecord(responseBody)) {
      throw new Error("Zoho Books returned an invalid invoice response.");
    }
    assertSuccessfulApiEnvelope(responseBody);

    return parseInvoiceResponse(responseBody, invoiceId);
  }

  private createInvoicesUrl(apiDomain: URL): URL {
    const url = new URL("/books/v3/invoices", apiDomain);
    url.searchParams.set("organization_id", this.organizationId);
    return url;
  }

  private async getAccessToken(): Promise<{ accessToken: string; apiDomain: URL }> {
    const token = await this.tokenProvider.getAccessToken();
    if (!token.accessToken.trim()) {
      throw new Error("Zoho access token provider returned an empty token.");
    }
    if (!token.scopes.split(",").some((scope) => scope.trim() === "ZohoBooks.invoices.READ")) {
      throw new Error("The connected Zoho account has not granted ZohoBooks.invoices.READ.");
    }
    return { accessToken: token.accessToken, apiDomain: validateApiDomain(token.apiDomain) };
  }

  private async request(url: URL, accessToken: string): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.transport(url, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        if (attempt >= this.maxRetries) {
          throw new ZohoBooksTransportError();
        }
        await this.sleep(Math.min(this.retryBaseDelayMs * 2 ** attempt, this.maxRetryDelayMs));
        continue;
      }

      if (response.ok) {
        return response;
      }

      const error = new ZohoBooksApiError(
        `Zoho Books invoice request failed with HTTP status ${response.status}.`,
        response.status,
      );
      if (!(response.status === 429 || response.status >= 500) || attempt >= this.maxRetries) {
        throw error;
      }

      const retryAfter = parseRetryAfter(response, Date.now());
      const delay =
        retryAfter ?? Math.min(this.retryBaseDelayMs * 2 ** attempt, this.maxRetryDelayMs);
      if (delay > this.maxRetryDelayMs) {
        throw error;
      }
      await this.sleep(delay);
    }
  }

  private async readJson(
    response: Response,
    resource: "invoice" | "invoice list",
  ): Promise<unknown> {
    try {
      const responseText = await response.text();
      return JSON.parse(preserveJsonNumberLexemes(responseText)) as unknown;
    } catch {
      throw new Error(`Zoho Books returned invalid JSON for the ${resource}.`);
    }
  }
}
