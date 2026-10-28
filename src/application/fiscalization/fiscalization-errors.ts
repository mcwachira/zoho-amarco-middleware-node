/**
 * Thrown when a Zoho invoice has already been registered
 * for fiscalization.
 */
export class DuplicateZohoInvoiceError extends Error {
  constructor(zohoInvoiceId: string) {
    super(`Zoho invoice "${zohoInvoiceId}" has already been registered for fiscalization.`);

    this.name = "DuplicateZohoInvoiceError";
  }
}

/** The invoice was validated but could not be durably registered. */
export class FiscalizationRequestPersistenceError extends Error {
  constructor() {
    super("Could not persist the fiscalization request.");
    this.name = "FiscalizationRequestPersistenceError";
  }
}
