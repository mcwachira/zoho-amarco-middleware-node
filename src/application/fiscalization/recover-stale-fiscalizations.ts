import type { FiscalizationRepository } from "./fiscalization-repository.js";

/**
 * Input required to recover stale fiscalization records.
 */
export interface RecoverStaleFiscalizationsInput {
  /** Records updated before this time are eligible for recovery. */
  readonly staleBefore: Date;

  /** Explains why the system marked the outcome as unknown. */
  readonly reason: string;
}

/**
 * Runs conservative recovery for fiscalization requests that appear stuck.
 *
 * This service never calls the fiscal device and never retries a receipt.
 * Records are marked OutcomeUnknown because a crashed process may have
 * issued a receipt before it stopped saving the result.
 */
export class RecoverStaleFiscalizationsService {
  constructor(private readonly repository: FiscalizationRepository) {}

  async execute(input: RecoverStaleFiscalizationsInput): Promise<number> {
    if (Number.isNaN(input.staleBefore.getTime())) {
      throw new Error("Recovery cutoff must be a valid date.");
    }

    const reason = input.reason.trim();

    if (reason.length === 0) {
      throw new Error("Recovery reason must not be empty.");
    }

    if (reason.length > 2000) {
      throw new Error("Recovery reason must not exceed 2000 characters.");
    }

    return this.repository.markStaleInProgressOutcomeUnknown(input.staleBefore, reason);
  }
}
