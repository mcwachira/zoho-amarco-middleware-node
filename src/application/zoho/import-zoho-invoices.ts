import { DuplicateZohoInvoiceError } from "../fiscalization/fiscalization-errors.js";
import type { PrepareFiscalizationRequestService } from "../fiscalization/prepare-fiscalization-request.js";
import {
  ZohoBooksApiError,
  ZohoBooksAuthorizationError,
  ZohoBooksTransportError,
  type ZohoBooksClient,
} from "../../integrations/zoho/books-client.js";

export interface ZohoInvoiceImportIssue {
  readonly invoiceId?: string;
  readonly category:
    | "validation_rejected"
    | "invoice_import_failed"
    | "invoice_list_failed"
    | "pagination_limit_reached"
    | "synchronization_cancelled";
  readonly code?:
    "ZOHO_API_ERROR" | "ZOHO_AUTH_ERROR" | "ZOHO_TRANSPORT_ERROR" | "INVALID_RESPONSE";
  readonly upstreamStatus?: number;
  readonly fields?: readonly {
    readonly field: string;
    readonly message: string;
  }[];
}

export interface ZohoInvoiceImportResult {
  readonly state: "completed" | "partial" | "failed";
  readonly paginationComplete: boolean;
  readonly discovered: number;
  readonly imported: number;
  readonly duplicatesSkipped: number;
  readonly rejected: number;
  readonly failed: number;
  readonly pagesRetrieved: number;
  readonly issues: readonly ZohoInvoiceImportIssue[];
}

export interface ZohoInvoiceImportOptions {
  readonly pageSize?: number;
  readonly maxPages?: number;
}

/**
 * Imports a complete page sequence into the existing fiscalization queue.
 *
 * A queue registration is still pending and this service has no device
 * dependency. Existing records are skipped before invoice retrieval; the
 * database's unique Zoho invoice constraint arbitrates concurrent imports.
 */
export class ImportZohoInvoicesService {
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(
    private readonly booksClient: Pick<ZohoBooksClient, "listInvoicesPage">,
    private readonly prepareRequest: Pick<
      PrepareFiscalizationRequestService,
      "findExisting" | "prepare"
    >,
    options: ZohoInvoiceImportOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 200;
    this.maxPages = options.maxPages ?? 1_000;

    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) {
      throw new Error("Invoice import page size must be between 1 and 200.");
    }
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 1_000) {
      throw new Error("Invoice import maximum pages must be between 1 and 1000.");
    }
  }

  async execute(signal?: AbortSignal): Promise<ZohoInvoiceImportResult> {
    let discovered = 0;
    let imported = 0;
    let duplicatesSkipped = 0;
    let rejected = 0;
    let failed = 0;
    let pagesRetrieved = 0;
    let paginationComplete = false;
    let cancelled = false;
    const issues: ZohoInvoiceImportIssue[] = [];

    for (let pageNumber = 1; pageNumber <= this.maxPages; pageNumber += 1) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }

      let page;
      try {
        page = signal
          ? await this.booksClient.listInvoicesPage(pageNumber, this.pageSize, signal)
          : await this.booksClient.listInvoicesPage(pageNumber, this.pageSize);
      } catch (error: unknown) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        issues.push({
          category: "invoice_list_failed",
          code:
            error instanceof ZohoBooksAuthorizationError
              ? "ZOHO_AUTH_ERROR"
              : error instanceof ZohoBooksApiError
                ? "ZOHO_API_ERROR"
                : error instanceof ZohoBooksTransportError
                  ? "ZOHO_TRANSPORT_ERROR"
                  : "INVALID_RESPONSE",
          ...(error instanceof ZohoBooksApiError ? { upstreamStatus: error.status } : {}),
        });
        break;
      }

      pagesRetrieved += 1;
      discovered += page.invoices.length;

      for (const invoice of page.invoices) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }

        try {
          if (await this.prepareRequest.findExisting(invoice.invoiceId)) {
            duplicatesSkipped += 1;
            continue;
          }

          signal?.throwIfAborted();
          const result = signal
            ? await this.prepareRequest.prepare(invoice.invoiceId, signal)
            : await this.prepareRequest.prepare(invoice.invoiceId);
          if (result.kind === "registered") {
            imported += 1;
          } else {
            rejected += 1;
            issues.push({
              invoiceId: invoice.invoiceId,
              category: "validation_rejected",
              fields: result.errors,
            });
          }
        } catch (error: unknown) {
          if (signal?.aborted) {
            cancelled = true;
            break;
          }
          if (error instanceof DuplicateZohoInvoiceError) {
            duplicatesSkipped += 1;
          } else {
            failed += 1;
            issues.push({
              invoiceId: invoice.invoiceId,
              category: "invoice_import_failed",
              code:
                error instanceof ZohoBooksAuthorizationError
                  ? "ZOHO_AUTH_ERROR"
                  : error instanceof ZohoBooksApiError
                    ? "ZOHO_API_ERROR"
                    : error instanceof ZohoBooksTransportError
                      ? "ZOHO_TRANSPORT_ERROR"
                      : "INVALID_RESPONSE",
              ...(error instanceof ZohoBooksApiError ? { upstreamStatus: error.status } : {}),
            });
          }
        }
      }

      if (cancelled) {
        break;
      }

      if (!page.hasMore) {
        paginationComplete = true;
        break;
      }
    }

    if (cancelled) {
      issues.push({ category: "synchronization_cancelled" });
    }

    if (!paginationComplete && pagesRetrieved === this.maxPages) {
      issues.push({ category: "pagination_limit_reached" });
    }

    const state =
      !paginationComplete && pagesRetrieved === 0
        ? "failed"
        : cancelled || !paginationComplete || rejected > 0 || failed > 0
          ? "partial"
          : "completed";

    return {
      state,
      paginationComplete,
      discovered,
      imported,
      duplicatesSkipped,
      rejected,
      failed,
      pagesRetrieved,
      issues,
    };
  }
}
