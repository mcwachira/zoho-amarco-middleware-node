import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  TremolHttpTransport,
  type TremolTransport,
  TremolTransportError,
} from "./tremol-zfplabserver-transport.js";

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
  /** Optional transport injection for deterministic tests and platform bridges. */
  readonly transport?: TremolTransport;
}

export class TremolHttpError extends Error {
  constructor(public readonly status: number) {
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
  constructor(public readonly resultCode: number) {
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

export { TremolTransportError };

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

const STATUS_FIELDS = {
  Power_down_in_opened_fiscal_receipt: "powerDownInOpenedFiscalReceipt",
  DateTime_not_set: "dateTimeNotSet",
  DateTime_wrong: "dateTimeWrong",
  RAM_reset: "ramReset",
  Hardware_clock_error: "hardwareClockError",
  Reports_registers_Overflow: "registersOverflow",
  Opened_Fiscal_Receipt: "fiscalReceiptOpened",
  Receipt_Invoice_Type: "receiptInvoiceType",
  SD_card_near_full: "sdCardNearFull",
  SD_card_full: "sdCardFull",
  CU_fiscalized: "cuFiscalized",
  CU_produced: "cuProduced",
  Paired_with_TIMS: "pairedWithTims",
  Unsent_receipts: "unsentReceipts",
  Service_contract_nearly_expired: "serviceContractNearlyExpired",
  No_Sec_IC: "noSecurityIc",
  No_certificates: "noCertificates",
  Service_jumper: "serviceJumper",
  Expired_service_contract: "expiredServiceContract",
  Missing_SD_card: "missingSdCard",
  Wrong_SD_card: "wrongSdCard",
  Update_is_available: "updateAvailable",
} as const satisfies Readonly<Record<string, Exclude<keyof TremolStatusFlags, "readiness">>>;

/**
 * The supplied Kenya SDK definitions map the protocol's named status bits to
 * `Type="Status"` values "0"/"1". Missing fields stay unknown; readiness is
 * never inferred. A captured response from the target LabServer is still
 * required to establish that installation's XML serialization.
 */
export function parseTremolStatusFlags(body: string): TremolStatusFlags {
  const resultCode = parseResultCode(body);
  if (resultCode !== 0) {
    throw new TremolDeviceError(resultCode);
  }

  const parsed = xmlParser.parse(body);
  if (!isRecord(parsed) || !isRecord(parsed["Res"])) {
    throw new TremolProtocolError("ZFPLabServer returned an invalid Res element.");
  }
  const rawValues = parsed["Res"]["Res"];
  const entries = Array.isArray(rawValues) ? rawValues : rawValues === undefined ? [] : [rawValues];
  const mapped: Partial<Record<Exclude<keyof TremolStatusFlags, "readiness">, boolean>> = {};

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = entry["@_Name"];
    if (typeof name !== "string" || !(name in STATUS_FIELDS)) continue;
    const flag = STATUS_FIELDS[name as keyof typeof STATUS_FIELDS];
    const value = entry["@_Value"];
    if (entry["@_Type"] !== "Status" || (value !== "0" && value !== "1")) {
      throw new TremolProtocolError(`ZFPLabServer returned an invalid ${name} status value.`);
    }
    if (flag in mapped) {
      throw new TremolProtocolError(`ZFPLabServer returned a duplicate ${name} status value.`);
    }
    mapped[flag] = value === "1";
  }

  return {
    readiness: "unknown",
    powerDownInOpenedFiscalReceipt: mapped.powerDownInOpenedFiscalReceipt ?? null,
    dateTimeNotSet: mapped.dateTimeNotSet ?? null,
    dateTimeWrong: mapped.dateTimeWrong ?? null,
    ramReset: mapped.ramReset ?? null,
    hardwareClockError: mapped.hardwareClockError ?? null,
    registersOverflow: mapped.registersOverflow ?? null,
    fiscalReceiptOpened: mapped.fiscalReceiptOpened ?? null,
    receiptInvoiceType: mapped.receiptInvoiceType ?? null,
    sdCardNearFull: mapped.sdCardNearFull ?? null,
    sdCardFull: mapped.sdCardFull ?? null,
    cuFiscalized: mapped.cuFiscalized ?? null,
    cuProduced: mapped.cuProduced ?? null,
    pairedWithTims: mapped.pairedWithTims ?? null,
    unsentReceipts: mapped.unsentReceipts ?? null,
    serviceContractNearlyExpired: mapped.serviceContractNearlyExpired ?? null,
    noSecurityIc: mapped.noSecurityIc ?? null,
    noCertificates: mapped.noCertificates ?? null,
    serviceJumper: mapped.serviceJumper ?? null,
    expiredServiceContract: mapped.expiredServiceContract ?? null,
    missingSdCard: mapped.missingSdCard ?? null,
    wrongSdCard: mapped.wrongSdCard ?? null,
    updateAvailable: mapped.updateAvailable ?? null,
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
    throw new TremolDeviceError(resultCode);
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
    throw new TremolDeviceError(resultCode);
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
  private readonly transport: TremolTransport;

  /**
   * Serializes commands within this client instance.
   * A failed command must not block later read operations forever.
   */
  private commandQueue: Promise<void> = Promise.resolve();

  constructor(options: TremolClientOptions) {
    const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`;

    this.baseUrl = new URL(baseUrl);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.transport =
      options.transport ??
      new TremolHttpTransport({
        timeoutMs: options.timeoutMs ?? 5_000,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

    if (
      !["http:", "https:"].includes(this.baseUrl.protocol) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash ||
      (this.baseUrl.pathname !== "/" && this.baseUrl.pathname !== "")
    ) {
      throw new Error(
        "ZFPLabServer URL must be an HTTP(S) origin without credentials or path data.",
      );
    }

    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 120_000) {
      throw new Error("timeoutMs must be an integer between 100 and 120000 milliseconds.");
    }
  }

  executeRead(command: TremolReadCommand): Promise<TremolCommandResponse> {
    if (
      command !== "ReadStatus()" &&
      command !== "ReadVersion()" &&
      command !== "ReadCurrentReceiptInfo()" &&
      command !== "ReadLastAndTotalReceiptNum()"
    ) {
      return Promise.reject(
        new TremolProtocolError("The requested Tremol command is unsupported."),
      );
    }
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

  /** Stops new requests and aborts any pending HTTP transport operations. */
  close(): Promise<void> {
    return this.transport.close();
  }

  private async executeReadInternal(command: TremolReadCommand): Promise<TremolCommandResponse> {
    const url = new URL(command, this.baseUrl);

    let response;
    try {
      response = await this.transport.get(url);
    } catch (error: unknown) {
      if (error instanceof TremolTransportError) throw error;
      throw new TremolTransportError("outcome-unknown", "network_error");
    }

    const { status, body } = response;

    if (status < 200 || status >= 300) throw new TremolHttpError(status);

    const resultCode = parseResultCode(body);

    if (resultCode !== 0) {
      throw new TremolDeviceError(resultCode);
    }

    return {
      status,
      resultCode,
      body,
    };
  }
}
