/**
 * Tremol G03 Kenya Fiscal Device Adapter
 *
 * This adapter implements the FiscalDevice interface for the Tremol G03
 * fiscal control unit connected via ZFP Lab Server.
 *
 * IMPORTANT: This implementation is based on the Kenya CU protocol document
 * (protocol_description_KE_CU_2509041522.pdf) and the ZFP Lab Server manual.
 * It MUST NOT be enabled for production use until:
 * 1. The exact command signatures and response contracts are verified against
 *    the installed ZFP Lab Server version
 * 2. The Kenya-specific protocol requirements are confirmed
 * 3. All payment, tax, and device configuration rules are validated
 * 4. The customer's specific device firmware and configuration are verified
 *
 * The adapter maintains sequential command execution and prevents overlapping
 * receipt transactions. It handles timeouts, failures, and ambiguous outcomes
 * according to the safety requirements.
 */

import type {
  FiscalDevice,
  FiscalDeviceResult,
} from "../../application/fiscalization/fiscal-device.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";
import { TremolZfpLabServerClient } from "./tremol-zfplabserver-client.js";
import { buildTremolReceiptCommandPlan } from "./tremol-receipt-command-builder.js";

/**
 * Configuration for the Tremol fiscal device.
 */
export interface TremolFiscalDeviceOptions {
  /** Base URL for the ZFP Lab Server */
  readonly baseUrl: string;
  /** Timeout in milliseconds for each device command */
  readonly commandTimeoutMs?: number;
  /** Maximum number of concurrent operations (default: 1 for safety) */
  readonly maxConcurrentOperations?: number;
  /** Whether to enable actual receipt issuance (default: false for safety) */
  readonly receiptIssuanceEnabled?: boolean;
  /** Timeout in milliseconds for the complete receipt sequence */
  readonly receiptTimeoutMs?: number;
  /** Optional HTTP boundary injection for deterministic local tests. */
  readonly fetchImpl?: typeof fetch;
  /** Share the configured read-only protocol client with diagnostics. */
  readonly client?: TremolZfpLabServerClient;
}

/**
 * Result of a Tremol command execution.
 */
interface TremolCommandResult {
  readonly success: boolean;
  readonly resultCode: number | null;
  readonly responseBody: string;
  readonly error?: Error;
}

/**
 * Tracks an in-progress receipt operation.
 */
interface InProgressReceipt {
  readonly snapshot: FiscalizationSnapshot;
  startedAt: Date;
  readonly commandsSent: string[];
  readonly commandResults: TremolCommandResult[];
}

/**
 * Error indicating that receipt issuance is disabled.
 */
export class ReceiptIssuanceDisabledError extends Error {
  constructor() {
    super("Fiscal receipt issuance is disabled because no verified Kenya command sequence exists.");
    this.name = "ReceiptIssuanceDisabledError";
  }
}

/**
 * Error indicating that a receipt is already in progress.
 */
export class ReceiptInProgressError extends Error {
  constructor() {
    super("A fiscal receipt operation is already in progress on this device.");
    this.name = "ReceiptInProgressError";
  }
}

/**
 * Error indicating that the device is not ready.
 */
export class DeviceNotReadyError extends Error {
  constructor(reason: string) {
    super(`Fiscal device is not ready: ${reason}`);
    this.name = "DeviceNotReadyError";
  }
}

/**
 * Error indicating a protocol violation or unsupported operation.
 */
export class TremolProtocolViolationError extends Error {
  constructor(message: string) {
    super(`Tremol protocol violation: ${message}`);
    this.name = "TremolProtocolViolationError";
  }
}

/**
 * Implements the FiscalDevice interface for Tremol G03 Kenya.
 *
 * This adapter:
 * - Executes commands sequentially to prevent overlapping receipts
 * - Validates responses against the protocol
 * - Handles timeouts and connection failures
 * - Prevents blind retries after uncertain outcomes
 * - Maintains independent state from eTIMS reporting
 */
export class TremolFiscalDevice implements FiscalDevice {
  readonly executionMode = "real" as const;
  private readonly client: TremolZfpLabServerClient;
  private readonly options: {
    readonly baseUrl: string;
    readonly commandTimeoutMs: number;
    readonly maxConcurrentOperations: number;
    readonly receiptIssuanceEnabled: boolean;
    readonly receiptTimeoutMs: number;
  };
  private inProgressReceipt: InProgressReceipt | null = null;
  private pendingOperations = 0;

  constructor(options: TremolFiscalDeviceOptions) {
    const commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    const receiptTimeoutMs = options.receiptTimeoutMs ?? 60000;
    const maxConcurrentOperations = options.maxConcurrentOperations ?? 1;
    if (maxConcurrentOperations !== 1) {
      throw new Error("Tremol command execution supports exactly one concurrent operation.");
    }
    for (const [name, timeout] of [
      ["commandTimeoutMs", commandTimeoutMs],
      ["receiptTimeoutMs", receiptTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 120_000) {
        throw new Error(`${name} must be an integer between 100 and 120000 milliseconds.`);
      }
    }

    this.client =
      options.client ??
      new TremolZfpLabServerClient({
        baseUrl: options.baseUrl,
        timeoutMs: commandTimeoutMs,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });

    this.options = {
      baseUrl: options.baseUrl,
      commandTimeoutMs,
      maxConcurrentOperations,
      receiptIssuanceEnabled: options.receiptIssuanceEnabled ?? false,
      receiptTimeoutMs,
    };
  }

  /**
   * Reports issuance readiness without issuing a command. The local contract
   * is not sufficient to infer Kenya G03 fiscal readiness, so this stays false.
   */
  async checkReadiness(): Promise<{ readonly ready: boolean; readonly reason?: string }> {
    if (!this.options.receiptIssuanceEnabled) {
      return { ready: false, reason: "Receipt issuance is disabled" };
    }

    // Check if there are any pending or in-progress operations
    if (this.pendingOperations > 0 || this.inProgressReceipt !== null) {
      return { ready: false, reason: "A receipt operation is already in progress" };
    }
    return {
      ready: false,
      reason:
        "Device connectivity does not establish fiscal readiness; the installed Kenya CU readiness contract is unverified.",
    };
  }

  /**
   * Issues a fiscal receipt for the given snapshot.
   *
   * Validates a snapshot and builds a non-executable command proposal. The
   * adapter always blocks before sending device commands until the Kenya
   * protocol contract has been verified.
   */
  async issueReceipt(snapshot: FiscalizationSnapshot): Promise<FiscalDeviceResult> {
    // Safety check: receipt issuance must be explicitly enabled
    if (!this.options.receiptIssuanceEnabled) {
      throw new ReceiptIssuanceDisabledError();
    }

    // Safety check: only one receipt at a time (synchronous check)
    // This prevents race conditions by checking before any async work begins
    if (this.inProgressReceipt !== null) {
      throw new ReceiptInProgressError();
    }

    // Increment pending operations counter for readiness checks BEFORE setting in-progress
    // This ensures the counter is accurate for the entire duration
    this.pendingOperations++;

    // Set in-progress state immediately to block subsequent synchronous checks
    // This must be done synchronously to prevent a second call from entering
    this.inProgressReceipt = {
      snapshot,
      startedAt: new Date(),
      commandsSent: [],
      commandResults: [],
    };

    try {
      // Safety check: validate snapshot
      if (!this.validateSnapshot(snapshot)) {
        return {
          kind: "failed",
          failure: {
            code: "INVALID_SNAPSHOT",
            message: "The fiscalization snapshot is invalid for Tremol receipt issuance.",
          },
        };
      }

      return await this.executeReceiptSequence(snapshot);
    } finally {
      // Always clear in-progress state and decrement counter
      // This ensures state is cleared even if execution fails
      this.inProgressReceipt = null;
      this.pendingOperations--;
    }
  }

  /**
   * Validates that the snapshot can be used for Tremol receipt issuance.
   */
  private validateSnapshot(snapshot: FiscalizationSnapshot): boolean {
    // Check schema version
    if (snapshot.schemaVersion !== 1) {
      return false;
    }

    // Check currency - Tremol Kenya implementation only supports KES
    if (snapshot.invoice.currencyCode !== "KES") {
      return false;
    }

    // Check required fields
    if (!snapshot.invoice.zohoInvoiceId || !snapshot.customer) {
      return false;
    }

    // Check line items
    if (snapshot.lineProfiles.length === 0) {
      return false;
    }

    if (snapshot.lineProfiles.length !== snapshot.invoice.lines.length) {
      return false;
    }

    return true;
  }

  /**
   * Executes the complete receipt command sequence.
   */
  private async executeReceiptSequence(
    snapshot: FiscalizationSnapshot,
  ): Promise<FiscalDeviceResult> {
    const timeoutMs = this.options.receiptTimeoutMs;

    // Update in-progress tracking start time
    if (this.inProgressReceipt) {
      this.inProgressReceipt.startedAt = new Date();
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Set up timeout for the entire receipt sequence
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Receipt issuance timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      // Execute the receipt sequence with timeout
      const result = await Promise.race([this.executeReceiptCommands(snapshot), timeoutPromise]);

      return result;
    } catch (error) {
      // Any error during execution means we cannot confirm the outcome
      const reason = error instanceof Error ? error.message : "Unknown execution error";
      return {
        kind: "outcome-unknown",
        reason: `Receipt issuance failed: ${reason}`,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    // Note: inProgressReceipt is cleared in the finally block of issueReceipt
  }

  /**
   * Executes all the Tremol commands for a receipt.
   */
  private async executeReceiptCommands(
    snapshot: FiscalizationSnapshot,
  ): Promise<FiscalDeviceResult> {
    try {
      // Step 1: Build the command plan (validation happens here)
      // Note: The current implementation has executable: false by design
      // This is a safety measure until the protocol is fully verified
      this.buildReceiptCommandPlan(snapshot);

      // For now, we return a blocked result until the protocol is verified
      return {
        kind: "failed",
        failure: {
          code: "RECEIPT_ISSUANCE_BLOCKED",
          message:
            "Receipt issuance is blocked until the Tremol G03 Kenya protocol and command contracts are fully verified.",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        kind: "failed",
        failure: {
          code: "INVALID_RECEIPT_PLAN",
          message: `Receipt request validation failed before device communication: ${message}`,
        },
      };
    }
  }

  /**
   * Builds the receipt command plan from the snapshot.
   *
   * This method maps the fiscalization snapshot to Tremol-specific commands.
   */
  private buildReceiptCommandPlan(
    snapshot: FiscalizationSnapshot,
  ): ReturnType<typeof buildTremolReceiptCommandPlan> {
    // Map the snapshot to the Tremol receipt customer and lines
    // Explicitly handle the exemptionNumber type conversion from string|null to string|undefined
    const customer: {
      companyName: string;
      clientPin: string;
      headquarters: string;
      address: string;
      postalCodeAndCity: string;
      exemptionNumber?: string;
      traderSystemInvoiceNumber: string;
    } = {
      companyName: snapshot.customer.companyName,
      clientPin: snapshot.customer.clientPin,
      headquarters: snapshot.customer.headquarters,
      address: snapshot.customer.address,
      postalCodeAndCity: snapshot.customer.postalCodeAndCity,
      ...(snapshot.customer.exemptionNumber !== null
        ? { exemptionNumber: snapshot.customer.exemptionNumber }
        : {}),
      traderSystemInvoiceNumber: snapshot.invoice.invoiceNumber ?? snapshot.invoice.zohoInvoiceId,
    };

    const lines = snapshot.lineProfiles.map((lineProfile, index) => {
      // We've already validated that lineProfiles.length === invoice.lines.length
      // in validateSnapshot, so this access is safe
      const line = snapshot.invoice.lines[index]!;

      // Build the line object - discountOrAdditionPercent is omitted since
      // it's not currently part of the FiscalizationSnapshot type
      const lineObj: {
        name: string;
        vatClass: string;
        price: string;
        unit: string;
        hsCode: string;
        hsName: string;
        vatGroupRate: string;
        quantity: string;
        discountOrAdditionPercent?: string;
      } = {
        name: line.description ?? line.itemId ?? `Line ${index + 1}`,
        vatClass: lineProfile.vatClass,
        price: line.unitPrice,
        unit: lineProfile.measureUnit,
        hsCode: lineProfile.hsCode,
        hsName: lineProfile.hsName,
        vatGroupRate: lineProfile.vatGroupRate,
        quantity: line.quantity,
      };

      return lineObj;
    });

    return buildTremolReceiptCommandPlan(customer, lines);
  }

  /**
   * Gets the current in-progress receipt (for diagnostics only).
   */
  getInProgressReceipt(): InProgressReceipt | null {
    return this.inProgressReceipt;
  }

  /**
   * Checks if receipt issuance is enabled.
   */
  get isIssuanceEnabled(): boolean {
    // This reflects the local guard only; getCapabilities() describes the
    // implemented capability and correctly keeps receipt issuance disabled.
    return this.options.receiptIssuanceEnabled;
  }

  getCapabilities(): {
    readonly transport: "zfplabserver_http";
    readonly supportedReadCommands: readonly ["ReadStatus", "ReadVersion"];
    readonly readinessDetermination: false;
    readonly receiptIssuance: false;
  } {
    return {
      transport: "zfplabserver_http",
      supportedReadCommands: ["ReadStatus", "ReadVersion"],
      readinessDetermination: false,
      receiptIssuance: false,
    };
  }

  /** Dispose the HTTP client when this adapter owns the lifecycle. */
  close(): Promise<void> {
    return this.client.close();
  }

  /**
   * Gets the device configuration.
   */
  getConfig(): Omit<TremolFiscalDeviceOptions, "receiptIssuanceEnabled"> {
    return {
      baseUrl: this.options.baseUrl,
      commandTimeoutMs: this.options.commandTimeoutMs,
      maxConcurrentOperations: this.options.maxConcurrentOperations,
      receiptTimeoutMs: this.options.receiptTimeoutMs,
    };
  }
}

/**
 * Creates a fail-closed Tremol adapter with safe defaults.
 */
export function createTremolFiscalDevice(
  baseUrl: string,
  options: Omit<TremolFiscalDeviceOptions, "baseUrl"> = {},
): TremolFiscalDevice {
  return new TremolFiscalDevice({
    baseUrl,
    commandTimeoutMs: 5000,
    maxConcurrentOperations: 1,
    receiptIssuanceEnabled: false, // SAFE DEFAULT: disabled until verified
    receiptTimeoutMs: 60000,
    ...options,
  });
}
