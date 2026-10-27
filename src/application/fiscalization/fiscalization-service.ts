import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalDevice, FiscalDeviceResult } from "./fiscal-device.js";
import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
import {
  FiscalizationSnapshotError,
  parseFiscalizationSnapshot,
} from "./fiscalization-snapshot.js";
import { InvalidFiscalizationOperationError } from "../../domain/fiscalization/fiscalization-errors.js";
import {
  completeFiscalization,
  failFiscalization,
  markOutcomeUnknown,
} from "../../domain/fiscalization/fiscalization-operations.js";

/**
 * Input for processing an existing, registered fiscalization request.
 */
export interface StartFiscalizationInput {
  readonly id: string;
}

/** The requested record does not exist. */
export class FiscalizationRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Fiscalization record "${id}" was not found.`);
    this.name = "FiscalizationRequestNotFoundError";
  }
}

/** The request exists but could not be claimed for processing. */
export class FiscalizationClaimError extends Error {
  constructor(id: string) {
    super(`Fiscalization record "${id}" could not be claimed.`);
    this.name = "FiscalizationClaimError";
  }
}

/**
 * The device operation was attempted, but its outcome could not be saved.
 * Reconciliation is required. Never retry the device operation automatically.
 */
export class FiscalizationPersistenceError extends Error {
  constructor(id: string) {
    super(
      `Could not persist the outcome for fiscalization record "${id}". Reconciliation is required.`,
    );
    this.name = "FiscalizationPersistenceError";
  }
}

export interface FiscalizationIssuancePolicy {
  readonly enabled: boolean;
  readonly paymentSourceVerified: boolean;
  readonly taxRulesVerified: boolean;
  readonly deviceContractVerified: boolean;
}

export type FiscalizationIssuanceBlocker =
  | "issuance_disabled"
  | "payment_source_unverified"
  | "tax_rules_unverified"
  | "device_contract_unverified"
  | "device_adapter_unavailable";

const disabledIssuancePolicy: FiscalizationIssuancePolicy = {
  enabled: false,
  paymentSourceVerified: false,
  taxRulesVerified: false,
  deviceContractVerified: false,
};

/** Issuance is unavailable until every authoritative prerequisite is verified. */
export class FiscalizationIssuanceDisabledError extends Error {
  constructor(readonly blockers: readonly FiscalizationIssuanceBlocker[]) {
    super("Fiscal receipt issuance is disabled.");
    this.name = "FiscalizationIssuanceDisabledError";
  }
}

/**
 * Runtime validation is necessary because TypeScript types do not validate
 * responses received from a device, SDK, or other runtime boundary.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check the result's discriminant and required top-level payload.
 * Domain operations perform the subsequent domain-specific validation.
 */
function isFiscalDeviceResult(value: unknown): value is FiscalDeviceResult {
  if (!isRecord(value)) {
    return false;
  }

  switch (value["kind"]) {
    case "succeeded":
      return isRecord(value["receipt"]);

    case "failed":
      return isRecord(value["failure"]);

    case "outcome-unknown":
      return typeof value["reason"] === "string";

    default:
      return false;
  }
}

export class FiscalizationService {
  constructor(
    private readonly repository: FiscalizationRepository,
    private readonly device: FiscalDevice | undefined,
    private readonly zohoOrganizationId: string,
    private readonly issuancePolicy: FiscalizationIssuancePolicy = disabledIssuancePolicy,
  ) {}

  getIssuanceBlockers(): readonly FiscalizationIssuanceBlocker[] {
    const blockers: FiscalizationIssuanceBlocker[] = [];

    if (!this.issuancePolicy.enabled) {
      blockers.push("issuance_disabled");
    }
    if (!this.issuancePolicy.paymentSourceVerified) {
      blockers.push("payment_source_unverified");
    }
    if (!this.issuancePolicy.taxRulesVerified) {
      blockers.push("tax_rules_unverified");
    }
    if (!this.issuancePolicy.deviceContractVerified) {
      blockers.push("device_contract_unverified");
    }
    if (!this.device) {
      blockers.push("device_adapter_unavailable");
    }

    return blockers;
  }

  async fiscalize(input: StartFiscalizationInput): Promise<FiscalizationRecord> {
    const blockers = this.getIssuanceBlockers();
    const device = this.device;
    if (blockers.length > 0 || !device) {
      throw new FiscalizationIssuanceDisabledError(blockers);
    }

    // Step 1: Load the request registered earlier.
    // This service must never create a second record.
    const existing = await this.repository.findById(input.id);

    if (existing === null) {
      throw new FiscalizationRequestNotFoundError(input.id);
    }

    // Validate the persisted source before the atomic claim. Legacy or
    // corrupt records must never fall back to live Zoho/profile data.
    const snapshot = parseFiscalizationSnapshot(existing.snapshot, existing.snapshotVersion);
    if (snapshot.invoice.zohoInvoiceId !== existing.zohoInvoiceId) {
      throw new FiscalizationSnapshotError(
        "The stored snapshot invoice does not match its request.",
      );
    }
    if (snapshot.zohoOrganizationId !== this.zohoOrganizationId) {
      throw new FiscalizationSnapshotError(
        "The stored snapshot belongs to a different configured Zoho organization.",
      );
    }

    // Step 3: Atomically claim Pending -> InProgress.
    // Only the successful claimant may proceed to the device.
    const claimed = await this.repository.claimPending(input.id);

    if (claimed === null) {
      throw new FiscalizationClaimError(input.id);
    }

    const claimedSnapshot = parseFiscalizationSnapshot(claimed.snapshot, claimed.snapshotVersion);
    if (
      claimedSnapshot.snapshotId !== snapshot.snapshotId ||
      claimedSnapshot.zohoOrganizationId !== this.zohoOrganizationId
    ) {
      throw new FiscalizationSnapshotError("The claimed request snapshot changed unexpectedly.");
    }

    // Step 4: Attempt the device operation once.
    // An exception cannot prove whether a receipt was issued.
    let rawResult: unknown;

    try {
      rawResult = await device.issueReceipt(claimedSnapshot);
    } catch {
      rawResult = undefined;
    }

    // Step 5: Translate the result into a domain outcome.
    // Malformed responses and unexpected transition errors are uncertain,
    // not proof of successful issuance or a confirmed device failure.
    let outcome: FiscalizationRecord;

    if (!isFiscalDeviceResult(rawResult)) {
      outcome = markOutcomeUnknown(
        claimed,
        "The device operation or its response could not be reliably confirmed.",
      );
    } else {
      try {
        switch (rawResult.kind) {
          case "succeeded":
            outcome = completeFiscalization(claimed, rawResult.receipt);
            break;

          case "failed":
            outcome = failFiscalization(claimed, rawResult.failure);
            break;

          case "outcome-unknown":
            outcome = markOutcomeUnknown(claimed, rawResult.reason);
            break;
        }
      } catch (error: unknown) {
        // The device was already called. If its result cannot be safely
        // translated, record uncertainty rather than guessing its outcome.
        outcome = markOutcomeUnknown(
          claimed,
          error instanceof InvalidFiscalizationOperationError
            ? `The device response could not be validated: ${error.message}`
            : "The device response could not be validated into a fiscalization outcome.",
        );
      }
    }

    // Step 6: Persist the outcome.
    // Never call the device again if outcome persistence fails.
    let saved: boolean;

    try {
      saved = await this.repository.saveOutcome(outcome);
    } catch {
      throw new FiscalizationPersistenceError(input.id);
    }

    if (!saved) {
      throw new FiscalizationPersistenceError(input.id);
    }

    return outcome;
  }
}
