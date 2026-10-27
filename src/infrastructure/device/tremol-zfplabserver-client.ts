import { XMLParser, XMLValidator } from "fast-xml-parser";

/**
 * Read-only commands supported by this client.
 *
 * Receipt-issuing commands remain excluded until their payloads,
 * responses, and fiscalization workflow are verified.
 */
export type TremolReadCommand =
  "ReadStatus()" | "ReadVersion()" | "ReadCurrentReceiptInfo()" | "ReadLastAndTotalReceiptNum()";

export interface TremolCommandResponse {
  readonly status: number;
  readonly resultCode: number;
  readonly body: string;
}

export interface TremolStatusFlags {
  readonly readiness: "unknown";
  readonly powerDownInOpenedFiscalReceipt: boolean | null;
  readonly dateTimeNotSet: boolean | null;
  readonly dateTimeWrong: boolean | null;
  readonly ramReset: boolean | null;
  readonly hardwareClockError: boolean | null;
  readonly registersOverflow: boolean | null;
  readonly fiscalReceiptOpened: boolean | null;
  readonly receiptInvoiceType: boolean | null;
  readonly sdCardNearFull: boolean | null;
  readonly sdCardFull: boolean | null;
  readonly cuFiscalized: boolean | null;
  readonly cuProduced: boolean | null;
  readonly pairedWithTims: boolean | null;
  readonly unsentReceipts: boolean | null;
  readonly serviceContractNearlyExpired: boolean | null;
  readonly noSecurityIc: boolean | null;
  readonly noCertificates: boolean | null;
  readonly serviceJumper: boolean | null;
  readonly expiredServiceContract: boolean | null;
  readonly missingSdCard: boolean | null;
  readonly wrongSdCard: boolean | null;
  readonly updateAvailable: boolean | null;
}

export interface TremolClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class TremolHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`ZFPLabServer returned HTTP ${status}.`);
    this.name = "TremolHttpError";
  }
}

/**
 * Indicates that ZFPLabServer returned a nonzero command result.
 *
 * This does not automatically mean the device state is unchanged.
 */
export class TremolDeviceError extends Error {
  constructor(
    public readonly resultCode: number,
    public readonly responseBody: string,
  ) {
    super(`ZFPLabServer command failed with result code ${resultCode}.`);
    this.name = "TremolDeviceError";
  }
}

/**
 * Indicates that the response did not match the documented ZFP XML envelope
 * or a command-specific field could not be validated.
 */
export class TremolProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TremolProtocolError";
  }
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  allowBooleanAttributes: false,
  trimValues: false,
});

/**
 * Validates the XML document and extracts the root Res element's Code.
 *
 * Command-specific response fields remain unparsed. The original body
 * is preserved for diagnostics.
 */
function parseResultCode(body: string): number {
  const validation = XMLValidator.validate(body);

  if (validation !== true) {
    throw new TremolProtocolError("ZFPLabServer returned malformed XML.");
  }

  let parsed: unknown;

  try {
    parsed = xmlParser.parse(body);
  } catch {
    throw new TremolProtocolError("ZFPLabServer returned an unparseable XML response.");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !("Res" in parsed)
  ) {
    throw new TremolProtocolError(
      "ZFPLabServer response must contain exactly one Res root element.",
    );
  }

  const root = (parsed as Record<string, unknown>)["Res"];

  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid Res element.");
  }

  const code = (root as Record<string, unknown>)["@_Code"];

  if (typeof code !== "string" || !/^\d+$/.test(code)) {
    throw new TremolProtocolError("ZFPLabServer response must contain a numeric Code attribute.");
  }

  const resultCode = Number(code);

  if (!Number.isSafeInteger(resultCode)) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid result code.");
  }

  return resultCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Kenya protocol defines six raw status bytes, but the supplied
 * ZFPLabServer documentation does not define their XML result names or value
 * serialization. Until that mapping is confirmed, all individual flags stay
 * unknown and readiness is never inferred.
 */
export function parseTremolStatusFlags(body: string): TremolStatusFlags {
  const resultCode = parseResultCode(body);
  if (resultCode !== 0) {
    throw new TremolDeviceError(resultCode, body);
  }

  return {
    readiness: "unknown",
    powerDownInOpenedFiscalReceipt: null,
    dateTimeNotSet: null,
    dateTimeWrong: null,
    ramReset: null,
    hardwareClockError: null,
    registersOverflow: null,
    fiscalReceiptOpened: null,
    receiptInvoiceType: null,
    sdCardNearFull: null,
    sdCardFull: null,
    cuFiscalized: null,
    cuProduced: null,
    pairedWithTims: null,
    unsentReceipts: null,
    serviceContractNearlyExpired: null,
    noSecurityIc: null,
    noCertificates: null,
    serviceJumper: null,
    expiredServiceContract: null,
    missingSdCard: null,
    wrongSdCard: null,
    updateAvailable: null,
  };
}

export interface TremolCloseReceiptMetadata {
  readonly invoiceNumber: string;
  readonly qrCode: string;
}

/**
 * Parses the documented CloseReceipt result fields from a successful generic
 * ZFPLabServer XML response. This is a parser only; it does not execute a
 * fiscal command or establish that a real receipt was issued.
 */
export function parseTremolCloseReceiptMetadata(body: string): TremolCloseReceiptMetadata {
  const resultCode = parseResultCode(body);
  if (resultCode !== 0) {
    throw new TremolDeviceError(resultCode, body);
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(body);
  } catch {
    throw new TremolProtocolError("ZFPLabServer returned an unparseable XML response.");
  }

  if (!isRecord(parsed) || !isRecord(parsed["Res"])) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid Res element.");
  }

  const resultValues = parsed["Res"]["Res"];
  const entries = Array.isArray(resultValues)
    ? resultValues
    : resultValues === undefined
      ? []
      : [resultValues];

  function requiredValue(name: "InvoiceNum" | "QRcode", maxLength: number): string {
    const matches = entries.filter((entry) => isRecord(entry) && entry["@_Name"] === name);
    if (matches.length !== 1 || !isRecord(matches[0])) {
      throw new TremolProtocolError(
        `ZFPLabServer response must contain exactly one ${name} value.`,
      );
    }

    const value = matches[0]["@_Value"];
    if (
      typeof value !== "string" ||
      value.length > maxLength ||
      (name === "InvoiceNum" && value.trim().length === 0)
    ) {
      throw new TremolProtocolError(`ZFPLabServer returned an invalid ${name} value.`);
    }

    return value;
  }

  return {
    invoiceNumber: requiredValue("InvoiceNum", 19),
    qrCode: requiredValue("QRcode", 128),
  };
}

export function parseTremolVersion(body: string): string {
  const validation = XMLValidator.validate(body);
  if (validation !== true) {
    throw new TremolProtocolError("ZFPLabServer returned malformed XML.");
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(body);
  } catch {
    throw new TremolProtocolError("ZFPLabServer returned an unparseable XML response.");
  }

  if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !("Res" in parsed)) {
    throw new TremolProtocolError(
      "ZFPLabServer response must contain exactly one Res root element.",
    );
  }

  const root = parsed["Res"];
  if (!isRecord(root)) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid Res element.");
  }

  const resultCodeValue = root["@_Code"];
  if (typeof resultCodeValue !== "string" || !/^\d+$/.test(resultCodeValue)) {
    throw new TremolProtocolError("ZFPLabServer response must contain a numeric Code attribute.");
  }
  const resultCode = Number(resultCodeValue);
  if (!Number.isSafeInteger(resultCode)) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid result code.");
  }
  if (resultCode !== 0) {
    throw new TremolDeviceError(resultCode, body);
  }

  const resultValues = root["Res"];
  const entries = Array.isArray(resultValues)
    ? resultValues
    : resultValues === undefined
      ? []
      : [resultValues];
  const versions = entries.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry["@_Name"] === "Version",
  );
  if (versions.length !== 1) {
    throw new TremolProtocolError("ZFPLabServer response must contain exactly one Version value.");
  }

  const version = versions[0]?.["@_Value"];
  if (typeof version !== "string" || !version.trim() || version.length > 30) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid Version value.");
  }

  return version.trim();
}

export class TremolZfpLabServerClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  /**
   * Serializes commands within this client instance.
   * A failed command must not block later read operations forever.
   */
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(options: TremolClientOptions) {
    const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;

    this.baseUrl = new URL(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (
      !["http:", "https:"].includes(this.baseUrl.protocol) ||
      this.baseUrl.username ||
      this.baseUrl.password
    ) {
      throw new Error("A valid HTTP(S) ZFPLabServer URL is required.");
    }

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer.");
    }
  }

  executeRead(command: TremolReadCommand): Promise<TremolCommandResponse> {
    const operation = this.commandQueue.then(() => this.executeReadInternal(command));

    this.commandQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  async readStatus(): Promise<{
    readonly response: TremolCommandResponse;
    readonly flags: TremolStatusFlags;
  }> {
    const response = await this.executeRead("ReadStatus()");
    return {
      response,
      flags: parseTremolStatusFlags(response.body),
    };
  }

  async readVersion(): Promise<{
    readonly response: TremolCommandResponse;
    readonly version: string;
  }> {
    const response = await this.executeRead("ReadVersion()");
    return {
      response,
      version: parseTremolVersion(response.body),
    };
  }

  private async executeReadInternal(command: TremolReadCommand): Promise<TremolCommandResponse> {
    const url = new URL(command, this.baseUrl);

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/xml, text/xml, text/plain",
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = await response.text();

    if (!response.ok) {
      throw new TremolHttpError(response.status, body);
    }

    const resultCode = parseResultCode(body);

    if (resultCode !== 0) {
      throw new TremolDeviceError(resultCode, body);
    }

    return {
      status: response.status,
      resultCode,
      body,
    };
  }
}
