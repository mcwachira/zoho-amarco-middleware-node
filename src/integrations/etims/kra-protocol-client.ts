import { z } from "zod";
import { currentCorrelationHeader } from "../../observability/request-context.js";

export const kraResultEnvelopeSchema = z
  .object({
    resultCd: z.string().length(3),
    resultMsg: z.string().max(2_000),
    resultDt: z
      .string()
      .regex(/^\d{14}$/)
      .optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type KraResultEnvelope = z.infer<typeof kraResultEnvelopeSchema>;

export type KraCallOutcome =
  | { readonly kind: "accepted"; readonly response: KraResultEnvelope }
  | {
      readonly kind: "rejected";
      readonly resultCode: string;
      readonly response: KraResultEnvelope;
    };

export type KraTypedCallOutcome<T> =
  | {
      readonly kind: "accepted";
      readonly response: Omit<KraResultEnvelope, "data"> & { readonly data: T };
    }
  | Extract<KraCallOutcome, { readonly kind: "rejected" }>;

export function validateKraAcceptedData<T>(
  outcome: KraCallOutcome,
  schema: z.ZodType<T>,
  operationName: string,
  outcomeMayBeUnknown = false,
): KraTypedCallOutcome<T> {
  if (outcome.kind === "rejected") return outcome;
  const parsed = schema.safeParse(outcome.response.data);
  if (!parsed.success) {
    throw new KraRequestError(
      `The eTIMS service returned invalid ${operationName} data.`,
      "malformed_response",
      outcomeMayBeUnknown,
    );
  }
  return {
    kind: "accepted",
    response: { ...outcome.response, data: parsed.data },
  };
}

export interface KraProtocolReadiness {
  readonly mode: "oscu" | "vscu";
  readonly environment: "sandbox" | "production" | "local-service";
  readonly configured: boolean;
  readonly configurationValid: true;
  readonly transportReady: "not_checked";
  readonly contractTests: "implemented_not_provider_verified";
  readonly contractVerified: false;
  readonly sandboxVerified: false;
  readonly providerApproved: false;
  readonly liveOperationPermitted: false;
  readonly supportedOperations: readonly string[];
  readonly reconciliationVerified: false;
  readonly blockers: readonly string[];
}

export class KraRequestError extends Error {
  constructor(
    message: string,
    readonly category:
      | "configuration"
      | "cancelled_before_send"
      | "timeout"
      | "transport"
      | "http"
      | "malformed_response",
    readonly outcomeMayBeUnknown: boolean,
  ) {
    super(message);
    this.name = "KraRequestError";
  }
}

export interface KraJsonClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly allowedOrigin: (url: URL) => boolean;
}

const requestSchema = z.record(z.string(), z.unknown());
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export class KraJsonProtocolClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: KraJsonClientOptions) {
    let url: URL;
    try {
      url = new URL(options.baseUrl);
    } catch {
      throw new KraRequestError("A valid eTIMS base URL is required.", "configuration", false);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !options.allowedOrigin(url)
    ) {
      throw new KraRequestError(
        "The eTIMS base URL is not permitted for this adapter.",
        "configuration",
        false,
      );
    }
    const timeout = options.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) {
      throw new KraRequestError(
        "The eTIMS timeout must be between 100 and 120000 milliseconds.",
        "configuration",
        false,
      );
    }
    this.baseUrl = new URL(url.href.endsWith("/") ? url.href : `${url.href}/`);
    this.timeoutMs = timeout;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    mayHaveSideEffects = true,
  ): Promise<KraCallOutcome> {
    if (signal?.aborted) {
      throw new KraRequestError(
        "The eTIMS request was cancelled before transmission.",
        "cancelled_before_send",
        false,
      );
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new KraRequestError(
        "The eTIMS request body must be a JSON object.",
        "configuration",
        false,
      );
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(parsed.data);
    } catch {
      throw new KraRequestError(
        "The eTIMS request body is not serializable JSON.",
        "configuration",
        false,
      );
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_REQUEST_BYTES) {
      throw new KraRequestError(
        "The eTIMS request exceeds the configured size limit.",
        "configuration",
        false,
      );
    }
    const endpoint = new URL(path.replace(/^\//, ""), this.baseUrl);
    if (
      endpoint.origin !== this.baseUrl.origin ||
      !endpoint.pathname.startsWith(this.baseUrl.pathname)
    ) {
      throw new KraRequestError("The eTIMS request path is not permitted.", "configuration", false);
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(new Error("timeout")), this.timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...currentCorrelationHeader(),
        },
        body: serialized,
        signal: combinedSignal,
        redirect: "error",
      });
    } catch {
      clearTimeout(timeout);
      throw new KraRequestError(
        signal?.aborted
          ? "The eTIMS request was cancelled after transmission began."
          : timeoutController.signal.aborted
            ? "The eTIMS request exceeded its timeout after transmission began."
            : "The eTIMS service did not return a response.",
        timeoutController.signal.aborted ? "timeout" : "transport",
        mayHaveSideEffects,
      );
    }
    try {
      if (!response.ok) {
        throw new KraRequestError(
          `The eTIMS service returned HTTP ${response.status}.`,
          "http",
          mayHaveSideEffects,
        );
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new KraRequestError(
          "The eTIMS response exceeds the configured size limit.",
          "malformed_response",
          mayHaveSideEffects,
        );
      }
      if (!response.body) {
        throw new KraRequestError(
          "The eTIMS service returned an empty response.",
          "malformed_response",
          mayHaveSideEffects,
        );
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new KraRequestError(
            "The eTIMS response exceeds the configured size limit.",
            "malformed_response",
            mayHaveSideEffects,
          );
        }
        chunks.push(part.value);
      }
      const responseText = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      );
      let decoded: unknown;
      try {
        decoded = JSON.parse(responseText) as unknown;
      } catch {
        throw new KraRequestError(
          "The eTIMS service returned malformed JSON.",
          "malformed_response",
          mayHaveSideEffects,
        );
      }
      const envelope = kraResultEnvelopeSchema.safeParse(decoded);
      if (!envelope.success) {
        throw new KraRequestError(
          "The eTIMS service returned an invalid response envelope.",
          "malformed_response",
          mayHaveSideEffects,
        );
      }
      return envelope.data.resultCd === "000"
        ? { kind: "accepted", response: envelope.data }
        : { kind: "rejected", resultCode: envelope.data.resultCd, response: envelope.data };
    } catch (error) {
      if (error instanceof KraRequestError) throw error;
      throw new KraRequestError(
        timeoutController.signal.aborted
          ? "The eTIMS response timed out after transmission began."
          : "The eTIMS response could not be read safely.",
        timeoutController.signal.aborted ? "timeout" : "malformed_response",
        mayHaveSideEffects,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const kraInitializationRequestSchema = z
  .object({
    tin: z.string().length(11),
    bhfId: z.string().length(2),
    dvcSrlNo: z.string().min(1).max(100),
  })
  .strict();

export type KraInitializationRequest = z.infer<typeof kraInitializationRequestSchema>;

function validCalendarDigits(value: string, dateOnly: boolean): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > daysInMonth || dateOnly) return day <= daysInMonth;
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  return hour <= 23 && minute <= 59 && second <= 59;
}
const date14 = z
  .string()
  .regex(/^\d{14}$/)
  .refine((value) => validCalendarDigits(value, false));
const date8 = z
  .string()
  .regex(/^\d{8}$/)
  .refine((value) => validCalendarDigits(value, true));
const amount18x2 = z
  .number()
  .finite()
  .nonnegative()
  .refine((value) => value < 1e16)
  .refine(
    (value) =>
      Number.isSafeInteger(Math.round(value * 100)) &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  );
const rate7x2 = z
  .number()
  .finite()
  .nonnegative()
  .refine((value) => value < 1e5)
  .refine(
    (value) =>
      Number.isSafeInteger(Math.round(value * 100)) &&
      Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
  );

const commonSalesFields = {
  tin: z.string().length(11),
  bhfId: z.string().length(2),
  trdInvcNo: z.string().min(1).max(50),
  invcNo: z.number().int().nonnegative().safe(),
  orgInvcNo: z.number().int().nonnegative().safe(),
  custTin: z.string().length(11).nullable().optional(),
  custNm: z.string().max(60).nullable().optional(),
  rcptTyCd: z.string().min(1).max(5),
  pmtTyCd: z.string().max(5).nullable().optional(),
  salesSttsCd: z.string().min(1).max(5),
  cfmDt: date14,
  salesDt: date8,
  stockRlsDt: date14.nullable().optional(),
  cnclReqDt: date14.nullable().optional(),
  cnclDt: date14.nullable().optional(),
  rfdDt: date14.nullable().optional(),
  rfdRsnCd: z.string().max(5).nullable().optional(),
  totItemCnt: z.number().int().positive().max(9_999_999_999),
  taxblAmtA: amount18x2,
  taxblAmtB: amount18x2,
  taxblAmtC: amount18x2,
  taxblAmtD: amount18x2,
  taxblAmtE: amount18x2,
  taxRtA: rate7x2,
  taxRtB: rate7x2,
  taxRtC: rate7x2,
  taxRtD: rate7x2,
  taxRtE: rate7x2,
  taxAmtA: amount18x2,
  taxAmtB: amount18x2,
  taxAmtC: amount18x2,
  taxAmtD: amount18x2,
  taxAmtE: amount18x2,
  totTaxblAmt: amount18x2,
  totTaxAmt: amount18x2,
  totAmt: amount18x2,
  prchrAcptcYn: z.enum(["Y", "N"]),
  remark: z.string().max(400).nullable().optional(),
  regrId: z.string().min(1).max(20),
  regrNm: z.string().min(1).max(60),
  modrId: z.string().min(1).max(20),
  modrNm: z.string().min(1).max(60),
};

const optionalText = (max: number) => z.string().max(max).nullable().optional();
const receiptCommonSchema = z.object({
  custTin: z.string().length(11).nullable().optional(),
  custMblNo: optionalText(20),
  trdeNm: optionalText(20),
  adrs: optionalText(200),
  topMsg: optionalText(20),
  btmMsg: optionalText(20),
  prchrAcptcYn: z.enum(["Y", "N"]),
});
const itemSchema = z
  .object({
    itemSeq: z.number().int().positive().max(999),
    itemClsCd: z.string().max(10).nullable().optional(),
    itemCd: z.string().min(1).max(20),
    itemNm: z.string().min(1).max(200),
    bcd: optionalText(20),
    pkgUnitCd: z.string().min(1).max(5),
    pkg: amount18x2,
    qtyUnitCd: z.string().min(1).max(5),
    qty: amount18x2,
    prc: amount18x2,
    splyAmt: amount18x2,
    dcRt: z
      .number()
      .finite()
      .nonnegative()
      .max(999.99)
      .refine(
        (value) =>
          Number.isSafeInteger(Math.round(value * 100)) &&
          Math.abs(value * 100 - Math.round(value * 100)) < 1e-7,
      ),
    dcAmt: amount18x2,
    isrccCd: optionalText(10),
    isrccNm: optionalText(100),
    isrcRt: z.number().int().nonnegative().max(999).nullable().optional(),
    isrcAmt: amount18x2.nullable().optional(),
    taxTyCd: z.string().min(1).max(5),
    taxblAmt: amount18x2,
    totTaxAmt: amount18x2,
    totAmt: amount18x2,
  })
  .strict();
const salesBaseSchema = z
  .object({
    ...commonSalesFields,
    receipt: receiptCommonSchema.extend({ rcptPbctDt: date14 }),
    itemList: z.array(itemSchema).min(1).max(10_000),
  })
  .strict();

function validateSalesConsistency(
  value: { itemList: { itemSeq: number }[]; totItemCnt: number },
  context: z.RefinementCtx,
) {
  if (value.itemList.length !== value.totItemCnt) {
    context.addIssue({
      code: "custom",
      path: ["totItemCnt"],
      message: "must equal itemList length",
    });
  }
  const sequences = value.itemList.map((item) => item.itemSeq);
  if (new Set(sequences).size !== sequences.length) {
    context.addIssue({
      code: "custom",
      path: ["itemList"],
      message: "itemSeq values must be unique",
    });
  }
}

/** OSCU request fields from §3.3.6.1. Values are never derived from guessed tax mappings. */
export const kraOscuSalesRequestSchema = salesBaseSchema
  .extend({
    cmcKey: z.string().min(1).max(255),
  })
  .superRefine(validateSalesConsistency);
export type KraOscuSalesRequest = z.infer<typeof kraOscuSalesRequestSchema>;

/** VSCU §3.3.6.1 only documents normal sales (salesTyCd N) for this operation. */
export const kraVscuSalesRequestSchema = salesBaseSchema
  .extend({
    salesTyCd: z.literal("N"),
    receipt: receiptCommonSchema.extend({
      rcptPbctDt: date14,
      rptNo: z.number().int().nonnegative().safe(),
    }),
  })
  .superRefine(validateSalesConsistency);
export type KraVscuSalesRequest = z.infer<typeof kraVscuSalesRequestSchema>;

export const kraOscuSalesResponseDataSchema = z
  .object({
    curRcptNo: z.number().int().nonnegative().safe(),
    totRcptNo: z.number().int().nonnegative().safe(),
    intrlData: z.string().max(26),
    rcptSign: z.string().max(16),
    sdcDateTime: date14,
  })
  .strict();
export type KraOscuSalesResponseData = z.infer<typeof kraOscuSalesResponseDataSchema>;

// VSCU's §3.3.6.1 response table and JSON example disagree on generated field names.
// This schema models the published example; this remains contract-unverified until KRA acceptance.
export const kraVscuSalesResponseDataSchema = z
  .object({
    rcptNo: z.number().int().nonnegative().safe(),
    intrlData: z.string().max(26),
    rcptSign: z.string().max(16),
    totRcptNo: z.number().int().nonnegative().safe(),
    VSCURcptPbctDate: date14,
    sdcId: z.string().min(1).max(20),
    mrcNo: z.string().min(1).max(20),
  })
  .strict();
export type KraVscuSalesResponseData = z.infer<typeof kraVscuSalesResponseDataSchema>;

export function validateKraSalesRequest(value: unknown, mode: "oscu" | "vscu"): readonly string[] {
  const parsed = (
    mode === "oscu" ? kraOscuSalesRequestSchema : kraVscuSalesRequestSchema
  ).safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `kraSales.${issue.path.map(String).join(".") || "request"}: ${issue.message}`,
    );
  }
  return [];
}

const mappedSalesRequests = new WeakMap<object, "oscu" | "vscu">();

/** Internal capability marker set only after the versioned fiscal mapping engine succeeds. */
export function markKraSalesRequestMapped(value: object, mode: "oscu" | "vscu"): void {
  mappedSalesRequests.set(value, mode);
}

export function isKraSalesRequestMapped(
  value: unknown,
  mode: "oscu" | "vscu",
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && mappedSalesRequests.get(value) === mode;
}

/** Converts an immutable decimal string to the numeric JSON form with a checked cent range. */
export function kraDecimalToNumber(value: string): number {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match)
    throw new Error(
      "KRA monetary values must be non-negative decimals with at most two fractional digits.",
    );
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("KRA monetary value exceeds the safe cent-precision range.");
  }
  return Number(cents) / 100;
}
