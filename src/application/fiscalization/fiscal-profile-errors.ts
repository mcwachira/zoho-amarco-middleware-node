export type FiscalProfileKind = "customer" | "item";

export class DuplicateFiscalProfileError extends Error {
  constructor(readonly kind: FiscalProfileKind) {
    super(`A fiscal ${kind} profile already exists for this Zoho identity.`);
    this.name = "DuplicateFiscalProfileError";
  }
}

export class FiscalProfileNotFoundError extends Error {
  constructor(readonly kind: FiscalProfileKind) {
    super(`The fiscal ${kind} profile was not found.`);
    this.name = "FiscalProfileNotFoundError";
  }
}

export class InvalidFiscalProfileError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = "InvalidFiscalProfileError";
  }
}
