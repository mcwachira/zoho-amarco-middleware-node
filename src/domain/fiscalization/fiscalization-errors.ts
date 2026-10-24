/**
 * Base class for errors caused by a fiscalization business rule.
 *
 * A separate error class lets the application distinguish expected
 * domain failures from unexpected programming or infrastructure errors.
 */
export class FiscalizationDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiscalizationDomainError";
  }
}

/**
 * Thrown when a requested status change violates the lifecycle rules.
 */
export class InvalidFiscalizationTransitionError extends FiscalizationDomainError {
  constructor(from: string, to: string) {
    super(`Cannot transition fiscalization from "${from}" to "${to}".`);
    this.name = "InvalidFiscalizationTransitionError";
  }
}

/**
 * Thrown when an operation requires a status the record does not have.
 *
 * Example: attaching a receipt before the fiscal operation is confirmed.
 */
export class InvalidFiscalizationOperationError extends FiscalizationDomainError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFiscalizationOperationError";
  }
}
