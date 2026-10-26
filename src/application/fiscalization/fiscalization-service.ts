import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalDevice, FiscalDeviceResult } from "./fiscal-device.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";
import { InvalidFiscalizationOperationError } from "../../domain/fiscalization/fiscalization-errors.js";
import { type FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
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
  readonly invoice: FiscalInvoiceCandidate;
}

/** The requested record does not exist. */
export class FiscalizationRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Fiscalization record "${id}" was not found.`);
    this.name = "FiscalizationRequestNotFoundError";
  }
}

/** The supplied invoice does not match the registered request. */
export class FiscalizationInvoiceMismatchError extends Error {
  constructor(id: string) {
    super(`The supplied Zoho invoice does not match fiscalization record "${id}".`);
    this.name = "FiscalizationInvoiceMismatchError";
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

export class FiscalizationService {
  constructor(
    private readonly repository: FiscalizationRepository,
    private readonly device: FiscalDevice,
  ) {}

  async fiscalize(input: StartFiscalizationInput): Promise<FiscalizationRecord> {
    // Step 1: Load the request that was registered earlier.
    // This service must never create a second record.
    const existing = await this.repository.findById(input.id);

    if (existing === null) {
      throw new FiscalizationRequestNotFoundError(input.id);
    }

    // Step 2: Ensure the supplied invoice belongs to this request.
    if (existing.zohoInvoiceId !== input.invoice.zohoInvoiceId) {
      throw new FiscalizationInvoiceMismatchError(input.id);
    }

    // Step 3: Atomically claim Pending -> InProgress.
    // Concurrent requests must not both reach the physical device.
    const claimed = await this.repository.claimPending(input.id);

    if (claimed === null) {
      throw new FiscalizationClaimError(input.id);
    }

    // Step 4: Call the device once only.
    // An exception does not prove that the device failed to issue a receipt.
    let result: FiscalDeviceResult | undefined;

    try {
      result = await this.device.issueReceipt(input.invoice);
    } catch {
      result = undefined;
    }

    // Step 5: Translate the device result into a domain outcome.
    let outcome: FiscalizationRecord;

    if (result === undefined) {
      outcome = markOutcomeUnknown(
        claimed,
        "The device operation or its response could not be reliably confirmed.",
      );
    } else {
      try {
        switch (result.kind) {
          case "succeeded":
            outcome = completeFiscalization(claimed, result.receipt);
            break;

          case "failed":
            outcome = failFiscalization(claimed, result.failure);
            break;

          case "outcome-unknown":
            outcome = markOutcomeUnknown(claimed, result.reason);
            break;
        }
      } catch (error: unknown) {
        if (!(error instanceof InvalidFiscalizationOperationError)) {
          throw error;
        }

        outcome = markOutcomeUnknown(
          claimed,
          `The device response could not be validated: ${error.message}`,
        );
      }
    }

    // Step 6: Persist the outcome. Never repeat the device call if saving fails.
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
