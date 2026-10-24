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
