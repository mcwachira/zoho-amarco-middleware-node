import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalDevice, FiscalDeviceResult } from "./fiscal-device.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";

import { InvalidFiscalizationOperationError } from "../../domain/fiscalization/fiscalization-errors.js";
import {
  createFiscalizationRecord,
  type FiscalizationRecord,
} from "../../domain/fiscalization/fiscalization-record.js";
import {
  completeFiscalization,
  failFiscalization,
  markOutcomeUnknown,
} from "../../domain/fiscalization/fiscalization-operations.js";

/**
 * Information required to start fiscalization for a mapped invoice.
 */
export interface StartFiscalizationInput {
  readonly id: string;
  readonly invoice: FiscalInvoiceCandidate;
}


/**
 * Thrown when a record cannot be claimed for processing.
 */
export class FiscalizationClaimError extends Error {
  constructor(id: string) {
    super(`Fiscalization record "${id}" could not be claimed.`);
    this.name = "FiscalizationClaimError";
  }
}

/**
 * Thrown when the device outcome cannot be saved.
 * Reconciliation is required; the device must not be called again automatically.
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

  /**
   * Creates a Pending record, claims it, and attempts to issue one receipt.
   */
  async fiscalize(input: StartFiscalizationInput): Promise<FiscalizationRecord> {
    // Step 1: Create the initial Pending record.
    const pending = createFiscalizationRecord({
      id: input.id,
      zohoInvoiceId: input.invoice.zohoInvoiceId,
    });
    await this.repository.create(pending);

    // Step 2: Atomically claim Pending -> InProgress.
    const claimed = await this.repository.claimPending(pending.id);

    if (claimed === null) {
      throw new FiscalizationClaimError(pending.id);
    }

    // Step 3: Call the device exactly once.
    let result: FiscalDeviceResult | undefined;

    try {
      result = await this.device.issueReceipt(input.invoice);
    } catch {
      // An exception or timeout does not prove that no receipt was issued.
      result = undefined;
    }

    // Step 4: Interpret the device result.
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
        // A malformed success response does not prove that the device
        // failed to issue a receipt. Preserve that uncertainty.
        if (!(error instanceof InvalidFiscalizationOperationError)) {
          throw error;
        }

        outcome = markOutcomeUnknown(
          claimed,
          `The device response could not be validated: ${error.message}`,
        );
      }
    }

    // Step 5: Persist the result. Never retry the device operation here.
    let saved: boolean;

    try {
      saved = await this.repository.saveOutcome(outcome);
    } catch {
      throw new FiscalizationPersistenceError(pending.id);
    }

    if (!saved) {
      throw new FiscalizationPersistenceError(pending.id);
    }

    return outcome;
  }
}
