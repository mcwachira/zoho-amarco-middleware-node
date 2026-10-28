/**
 * Minimal Zoho Books invoice client.
 *
 * This integration retrieves invoices only. It does not fiscalize them,
 * modify Zoho records, or communicate with the Tremol device.
 */

import { parseZohoBooksApiDomain } from "./api-domain.js";
import { currentCorrelationHeader } from "../../observability/request-context.js";

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

export interface ZohoPayment {
  readonly paymentId: string;
  readonly paymentNumber: string | null;
  readonly paymentMode: string | null;
  readonly amount: string;
  readonly date: string | null;
  readonly referenceNumber: string | null;
  readonly description: string | null;
  readonly source: Readonly<Record<string, unknown>>;
}

export interface ZohoPaymentListPage {
  readonly page: number;
  readonly payments: readonly ZohoPayment[];
  readonly hasMore: boolean;
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
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
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
  constructor(readonly category: "timeout" | "network_error" = "network_error") {
    super("Zoho Books request failed before a response was received.");
    this.name = "ZohoBooksTransportError";
  }
}

export class ZohoBooksResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZohoBooksResponseError";
  }
}

export class ZohoBooksAuthorizationError extends Error {
  constructor() {
    super("Zoho authorization is unavailable or lacks the required invoice-read permission.");
    this.name = "ZohoBooksAuthorizationError";
  }
}

export type ZohoBooksWritebackErrorCategory =
  | "authorization"
  | "not_found"
  | "rate_limited"
  | "validation"
  | "server_error"
  | "network_error"
  | "malformed_response";

export class ZohoBooksWritebackError extends Error {
  constructor(
    readonly category: ZohoBooksWritebackErrorCategory,
    readonly outcome: "definitive_failure" | "outcome_unknown",
    readonly httpStatus: number | null = null,
    readonly apiCode: number | null = null,
  ) {
    super(`Zoho Books custom-field writeback failed (${category}).`);
    this.name = "ZohoBooksWritebackError";
  }
}

const MAX_INVOICE_PAGE_SIZE = 200;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ZohoBooksResponseError(`Zoho invoice response is missing a valid ${field}.`);
  }

  return value.trim();
}

function validateIdentifier(value: string, field: string): string {
  const identifier = value.trim();
  if (!isValidZohoBooksIdentifier(identifier)) {
    throw new Error(`A valid Zoho ${field} is required.`);
  }
  return identifier;
}

/** Matches the opaque identifier policy used by Zoho Books client requests. */
export function isValidZohoBooksIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.trim());
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validateApiDomain(value: string): URL {
  const url = parseZohoBooksApiDomain(value);

  if (url === null) {
    throw new ZohoBooksResponseError("Zoho returned an invalid API domain.");
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
    "amount",
    "amount_applied",
    "balance_amount",
    "tax_amount_withheld",
    "discount",
    "discount_amount",
  ]);
  const identifierFields = new Set([
    "invoice_id",
    "customer_id",
    "item_id",
    "line_item_id",
    "organization_id",
    "tax_id",
    "payment_id",
    "invoice_payment_id",
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
    throw new ZohoBooksResponseError("Zoho returned an invalid invoice response.");
  }

  const envelope = value as Record<string, unknown>;
  const invoiceValue = envelope["invoice"];

  if (typeof invoiceValue !== "object" || invoiceValue === null || Array.isArray(invoiceValue)) {
    throw new ZohoBooksResponseError("Zoho response does not contain a valid invoice.");
  }

  const invoice = invoiceValue as Record<string, unknown>;
  const invoiceId = requiredText(invoice["invoice_id"], "invoice ID");

  if (invoiceId !== requestedInvoiceId) {
    throw new ZohoBooksResponseError("Zoho returned an invoice with an unexpected ID.");
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
    throw new ZohoBooksResponseError("Zoho Books returned an invalid API response code.");
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

function parsePaymentListPage(value: unknown, page: number): ZohoPaymentListPage {
  if (!isRecord(value)) {
    throw new Error("Zoho Books returned an invalid payment-list response.");
  }

  assertSuccessfulApiEnvelope(value);

  const paymentValues = value["payments"];
  const pageContext = value["page_context"];
  if (!Array.isArray(paymentValues) || !isRecord(pageContext)) {
    throw new Error("Zoho Books returned an incomplete payment-list page.");
  }

  const hasMore = pageContext["has_more_page"];
  if (typeof hasMore !== "boolean") {
    throw new Error("Zoho Books payment-list page is missing pagination metadata.");
  }

  const payments = paymentValues.map((paymentValue): ZohoPayment => {
    if (!isRecord(paymentValue)) {
      throw new Error("Zoho Books returned an invalid payment summary.");
    }

    return {
      paymentId: requiredText(paymentValue["payment_id"], "payment ID"),
      paymentNumber: optionalText(paymentValue["payment_number"]),
      paymentMode: optionalText(paymentValue["payment_mode"]),
      amount: requiredText(paymentValue["amount"], "amount"),
      date: optionalText(paymentValue["date"]),
      referenceNumber: optionalText(paymentValue["reference_number"]),
      description: optionalText(paymentValue["description"]),
      source: paymentValue,
    };
  });

  return { page, payments, hasMore };
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
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ZohoBooksClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.organizationId = validateIdentifier(options.organizationId, "organization ID");
    this.transport = options.transport ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 100;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5_000;
    this.sleep =
      options.sleep ??
      ((milliseconds, signal) =>
        new Promise((resolve, reject) => {
          signal?.throwIfAborted();
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, milliseconds);
          const abort = (): void => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal?.reason);
          };
          signal?.addEventListener("abort", abort, { once: true });
        }));

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
    signal?: AbortSignal,
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

    signal?.throwIfAborted();
    const token = await this.getAccessToken("ZohoBooks.invoices.READ");
    signal?.throwIfAborted();
    const url = this.createInvoicesUrl(token.apiDomain);
    url.searchParams.set("page", String(pageInput));
    url.searchParams.set("per_page", String(perPageInput));

    const response = await this.request(url, token.accessToken, signal);
    const responseBody = await this.readJson(response, "invoice list");
    return parseInvoiceListPage(responseBody, pageInput);
  }

  /**
   * Fetches one invoice from Zoho Books.
   *
   * This method never returns or logs the OAuth access token.
   */
  async getInvoice(invoiceIdInput: string, signal?: AbortSignal): Promise<ZohoInvoice> {
    const invoiceId = validateIdentifier(invoiceIdInput, "invoice ID");

    signal?.throwIfAborted();
    const token = await this.getAccessToken("ZohoBooks.invoices.READ");
    signal?.throwIfAborted();
    const invoiceUrl = new URL(
      `/books/v3/invoices/${encodeURIComponent(invoiceId)}`,
      token.apiDomain,
    );
    invoiceUrl.searchParams.set("organization_id", this.organizationId);

    const response = await this.request(invoiceUrl, token.accessToken, signal);
    try {
      const responseBody = await this.readJson(response, "invoice");
      if (!isRecord(responseBody)) {
        throw new ZohoBooksResponseError("Zoho Books returned an invalid invoice response.");
      }
      assertSuccessfulApiEnvelope(responseBody);

      return parseInvoiceResponse(responseBody, invoiceId);
    } catch (error: unknown) {
      if (error instanceof ZohoBooksApiError || error instanceof ZohoBooksResponseError)
        throw error;
      throw new ZohoBooksResponseError("Zoho Books returned an invalid invoice response.");
    }
  }

  getOrganizationId(): string {
    return this.organizationId;
  }

  /**
   * Updates one configured invoice custom field via Zoho's dedicated
   * custom-field endpoint. This request is intentionally never retried.
   */
  async updateInvoiceCustomField(
    invoiceIdInput: string,
    customFieldIdInput: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const invoiceId = validateIdentifier(invoiceIdInput, "invoice ID");
    const customFieldId = customFieldIdInput.trim();
    if (!/^\d{1,40}$/.test(customFieldId) || typeof value !== "string" || value.length > 1_000) {
      throw new ZohoBooksWritebackError("validation", "definitive_failure");
    }
    signal?.throwIfAborted();

    let token: { accessToken: string; apiDomain: URL };
    try {
      token = await this.getAccessToken("ZohoBooks.invoices.UPDATE");
    } catch {
      throw new ZohoBooksWritebackError("authorization", "definitive_failure");
    }
    signal?.throwIfAborted();

    const url = new URL(
      `/books/v3/invoice/${encodeURIComponent(invoiceId)}/customfields`,
      token.apiDomain,
    );
    url.searchParams.set("organization_id", this.organizationId);

    let response: Response | undefined;
    for (let attempt = 0; attempt <= Math.min(this.maxRetries, 2); attempt += 1) {
      signal?.throwIfAborted();
      try {
        response = await this.transport(url, {
          method: "PUT",
          headers: {
            Authorization: `Zoho-oauthtoken ${token.accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            ...currentCorrelationHeader(),
          },
          body: JSON.stringify({ customfield_id: customFieldId, value }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        });
      } catch {
        signal?.throwIfAborted();
        throw new ZohoBooksWritebackError("network_error", "outcome_unknown");
      }
      if (response.status !== 429 || attempt >= Math.min(this.maxRetries, 2)) break;
      const retryAfter = parseRetryAfter(response, Date.now());
      const delay =
        retryAfter ?? Math.min(this.retryBaseDelayMs * 2 ** attempt, this.maxRetryDelayMs);
      if (delay > this.maxRetryDelayMs) break;
      if (signal) await this.sleep(delay, signal);
      else await this.sleep(delay);
    }

    if (!response || !response.ok) {
      const status = response?.status ?? 0;
      const { category, outcome } = classifyWritebackHttpError(status);
      throw new ZohoBooksWritebackError(category, outcome, status || null);
    }

    let body: unknown;
    try {
      body = JSON.parse(await response.text()) as unknown;
    } catch {
      throw new ZohoBooksWritebackError("malformed_response", "outcome_unknown", response.status);
    }
    if (
      !isRecord(body) ||
      typeof body["code"] !== "number" ||
      !Number.isSafeInteger(body["code"])
    ) {
      throw new ZohoBooksWritebackError("malformed_response", "outcome_unknown", response.status);
    }
    if (body["code"] !== 0) {
      throw new ZohoBooksWritebackError(
        "validation",
        "definitive_failure",
        response.status,
        body["code"],
      );
    }
  }

  /**
   * Fetches payments for an invoice from Zoho Books.
   *
   * This method retrieves the list of payments applied to a specific invoice.
   * It never returns or logs the OAuth access token.
   */
  async getInvoicePayments(
    invoiceIdInput: string,
    signal?: AbortSignal,
    pageInput = 1,
  ): Promise<ZohoPaymentListPage> {
    const invoiceId = validateIdentifier(invoiceIdInput, "invoice ID");
    if (!Number.isSafeInteger(pageInput) || pageInput < 1) {
      throw new Error("Payment page must be a positive integer.");
    }

    signal?.throwIfAborted();
    const token = await this.getAccessToken("ZohoBooks.invoices.READ");
    signal?.throwIfAborted();
    const paymentsUrl = new URL(
      `/books/v3/invoices/${encodeURIComponent(invoiceId)}/payments`,
      token.apiDomain,
    );
    paymentsUrl.searchParams.set("organization_id", this.organizationId);
    paymentsUrl.searchParams.set("page", String(pageInput));
    paymentsUrl.searchParams.set("per_page", String(MAX_INVOICE_PAGE_SIZE));

    const response = await this.request(paymentsUrl, token.accessToken, signal);
    const responseBody = await this.readJson(response, "invoice payments");
    if (!isRecord(responseBody)) {
      throw new Error("Zoho Books returned an invalid payments response.");
    }
    assertSuccessfulApiEnvelope(responseBody);

    return parsePaymentListPage(responseBody, pageInput);
  }

  private createInvoicesUrl(apiDomain: URL): URL {
    const url = new URL("/books/v3/invoices", apiDomain);
    url.searchParams.set("organization_id", this.organizationId);
    return url;
  }

  private async getAccessToken(
    requiredScope: "ZohoBooks.invoices.READ" | "ZohoBooks.invoices.UPDATE",
  ): Promise<{ accessToken: string; apiDomain: URL }> {
    let token: Awaited<ReturnType<ZohoAccessTokenProvider["getAccessToken"]>>;
    try {
      token = await this.tokenProvider.getAccessToken();
    } catch (error: unknown) {
      if (error instanceof ZohoBooksAuthorizationError) throw error;
      throw new ZohoBooksAuthorizationError();
    }
    if (
      !token.accessToken.trim() ||
      !token.scopes.split(",").some((scope) => scope.trim() === requiredScope)
    ) {
      throw new ZohoBooksAuthorizationError();
    }
    return { accessToken: token.accessToken, apiDomain: validateApiDomain(token.apiDomain) };
  }

  private async request(url: URL, accessToken: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      let response: Response;
      const timeoutSignal = AbortSignal.timeout(10_000);
      try {
        response = await this.transport(url, {
          method: "GET",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            Accept: "application/json",
            ...currentCorrelationHeader(),
          },
          signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
        });
      } catch {
        signal?.throwIfAborted();
        if (attempt >= this.maxRetries) {
          throw new ZohoBooksTransportError(timeoutSignal.aborted ? "timeout" : "network_error");
        }
        const delay = Math.min(this.retryBaseDelayMs * 2 ** attempt, this.maxRetryDelayMs);
        if (signal) await this.sleep(delay, signal);
        else await this.sleep(delay);
        continue;
      }

      if (response.ok) {
        return response;
      }

      const error = new ZohoBooksApiError(
        `Zoho Books invoice request failed with HTTP status ${response.status}.`,
        response.status,
        response.status === 404 ? await readSafeApiCode(response) : undefined,
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
      if (signal) await this.sleep(delay, signal);
      else await this.sleep(delay);
    }
  }

  private async readJson(
    response: Response,
    resource: "invoice" | "invoice list" | "invoice payments",
  ): Promise<unknown> {
    try {
      const responseText = await response.text();
      return JSON.parse(preserveJsonNumberLexemes(responseText)) as unknown;
    } catch {
      throw new ZohoBooksResponseError(`Zoho Books returned invalid JSON for the ${resource}.`);
    }
  }
}

/** Reads only Zoho's numeric error code from a bounded copy of an error body. */
async function readSafeApiCode(response: Response): Promise<number | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (length < 8_192) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 8_192 - length;
      const chunk = value.subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.length;
      if (chunk.length < value.length) {
        await reader.cancel();
        break;
      }
    }
    const text = new TextDecoder().decode(concatChunks(chunks, length));
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const code = (body as Record<string, unknown>)["code"];
    return typeof code === "number" && Number.isSafeInteger(code) ? code : undefined;
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function concatChunks(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function classifyWritebackHttpError(status: number): {
  readonly category: ZohoBooksWritebackErrorCategory;
  readonly outcome: "definitive_failure" | "outcome_unknown";
} {
  if (status === 401 || status === 403) {
    return { category: "authorization", outcome: "definitive_failure" };
  }
  if (status === 404) return { category: "not_found", outcome: "definitive_failure" };
  if (status === 429) return { category: "rate_limited", outcome: "definitive_failure" };
  if (status === 400 || status === 422) {
    return { category: "validation", outcome: "definitive_failure" };
  }
  return {
    category: "server_error",
    outcome: status >= 500 ? "outcome_unknown" : "definitive_failure",
  };
}
