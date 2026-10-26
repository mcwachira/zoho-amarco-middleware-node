import type { ZohoBooksClient } from "../../integrations/zoho/books-client.js";
import { mapZohoInvoice, type InvoiceMappingResult } from "./zoho-invoice-mapper.js";

/**
 * Coordinates invoice retrieval and mapping.
 *
 * This service does not access the database, communicate with the
 * fiscal device, or submit anything to KRA/eTIMS.
 */
export class ZohoInvoiceService {
  constructor(private readonly booksClient: Pick<ZohoBooksClient, "getInvoice">) {}

  /**
   * Retrieves a Zoho Books invoice and maps its data into our
   * internal fiscal-invoice candidate format.
   *
   * Zoho API errors are allowed to propagate to the caller.
   * Mapping failures are returned as structured validation errors.
   */
  async getFiscalInvoiceCandidate(invoiceId: string): Promise<InvoiceMappingResult> {
    const invoice = await this.booksClient.getInvoice(invoiceId);

    return mapZohoInvoice(invoice);
  }
}
