import { describe, expect, it, vi } from "vitest";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import type { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import { ImportZohoInvoicesService } from "../../src/application/zoho/import-zoho-invoices.js";
import type {
  ZohoBooksClient,
  ZohoInvoiceListPage,
} from "../../src/integrations/zoho/books-client.js";
import { ZohoBooksApiError } from "../../src/integrations/zoho/books-client.js";

function createHarness(
  pages: readonly ZohoInvoiceListPage[],
  prepareInvoice?: (invoiceId: string) => Promise<unknown>,
) {
  const listInvoicesPage = vi.fn(async (page: number) => {
    const result = pages[page - 1];
    if (!result) {
      throw new Error("Unexpected page request");
    }
    return result;
  });
  const prepare = vi.fn(
    prepareInvoice ??
      (async () => ({
        kind: "registered" as const,
        record: { id: "request-id" },
      })),
  );
  const findExisting = vi.fn().mockResolvedValue(null);
  const service = new ImportZohoInvoicesService(
    { listInvoicesPage } as unknown as Pick<ZohoBooksClient, "listInvoicesPage">,
    { findExisting, prepare } as unknown as Pick<
      PrepareFiscalizationRequestService,
      "findExisting" | "prepare"
    >,
    { pageSize: 2 },
  );

  return { service, listInvoicesPage, findExisting, prepare };
}

function page(pageNumber: number, invoiceIds: readonly string[], hasMore: boolean) {
  return {
    page: pageNumber,
    invoices: invoiceIds.map((invoiceId) => ({ invoiceId, invoiceNumber: null })),
    hasMore,
  } satisfies ZohoInvoiceListPage;
}

describe("ImportZohoInvoicesService", () => {
  it("enforces bounded configurable pagination limits", () => {
    const booksClient = { listInvoicesPage: vi.fn() } as unknown as Pick<
      ZohoBooksClient,
      "listInvoicesPage"
    >;
    const prepare = { findExisting: vi.fn(), prepare: vi.fn() } as unknown as Pick<
      PrepareFiscalizationRequestService,
      "findExisting" | "prepare"
    >;

    expect(() => new ImportZohoInvoicesService(booksClient, prepare, { pageSize: 201 })).toThrow(
      "Invoice import page size must be between 1 and 200.",
    );
    expect(() => new ImportZohoInvoicesService(booksClient, prepare, { maxPages: 1_001 })).toThrow(
      "Invoice import maximum pages must be between 1 and 1000.",
    );
  });

  it("retrieves and registers invoices from every page", async () => {
    const { service, listInvoicesPage, prepare } = createHarness([
      page(1, ["invoice-1", "invoice-2"], true),
      page(2, ["invoice-3"], false),
    ]);

    await expect(service.execute()).resolves.toMatchObject({
      state: "completed",
      paginationComplete: true,
      discovered: 3,
      imported: 3,
      duplicatesSkipped: 0,
      rejected: 0,
      failed: 0,
      pagesRetrieved: 2,
    });
    expect(listInvoicesPage.mock.calls).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect(prepare.mock.calls).toEqual([["invoice-1"], ["invoice-2"], ["invoice-3"]]);
  });

  it("counts unique-constraint conflicts as skipped duplicates", async () => {
    const { service, prepare } = createHarness(
      [page(1, ["invoice-existing", "invoice-new"], false)],
      async (invoiceId) => {
        if (invoiceId === "invoice-existing") {
          throw new DuplicateZohoInvoiceError(invoiceId);
        }
        return { kind: "registered" as const, record: { id: "new" } };
      },
    );

    await expect(service.execute()).resolves.toMatchObject({
      state: "completed",
      discovered: 2,
      imported: 1,
      duplicatesSkipped: 1,
      rejected: 0,
    });
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("skips an existing record before invoice retrieval without changing its state or snapshot", async () => {
    const storedRecord = Object.freeze({
      id: "request-unknown",
      status: "OutcomeUnknown",
      snapshot: Object.freeze({ invoice: Object.freeze({ invoiceNumber: "ORIGINAL" }) }),
    });
    const { service, findExisting, prepare } = createHarness([
      page(1, ["invoice-existing"], false),
    ]);
    findExisting.mockResolvedValue(storedRecord);

    await expect(service.execute()).resolves.toMatchObject({
      state: "completed",
      discovered: 1,
      imported: 0,
      duplicatesSkipped: 1,
      rejected: 0,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(storedRecord).toEqual({
      id: "request-unknown",
      status: "OutcomeUnknown",
      snapshot: { invoice: { invoiceNumber: "ORIGINAL" } },
    });
  });

  it("handles concurrent imports using the database duplicate result without mutation", async () => {
    const existing = new Set<string>();
    const prepareInvoice = vi.fn(async (invoiceId: string) => {
      if (existing.has(invoiceId)) {
        throw new DuplicateZohoInvoiceError(invoiceId);
      }
      existing.add(invoiceId);
      return { kind: "registered" as const, record: { id: `record-${invoiceId}` } };
    });
    const { service } = createHarness([page(1, ["same-invoice"], false)], prepareInvoice);

    const [first, second] = await Promise.all([service.execute(), service.execute()]);

    expect(first.imported + second.imported).toBe(1);
    expect(first.duplicatesSkipped + second.duplicatesSkipped).toBe(1);
    expect(existing).toEqual(new Set(["same-invoice"]));
  });

  it("reports validation failures and continues importing later invoices", async () => {
    const { service } = createHarness(
      [page(1, ["invalid-invoice", "valid-invoice"], false)],
      async (invoiceId) =>
        invoiceId === "invalid-invoice"
          ? {
              kind: "mapping-failed" as const,
              errors: [{ field: "total", message: "Must be a valid decimal value" }],
            }
          : { kind: "registered" as const, record: { id: "request-id" } },
    );

    await expect(service.execute()).resolves.toMatchObject({
      state: "partial",
      paginationComplete: true,
      discovered: 2,
      imported: 1,
      rejected: 1,
      issues: [
        {
          invoiceId: "invalid-invoice",
          category: "validation_rejected",
          fields: [{ field: "total", message: "Must be a valid decimal value" }],
        },
      ],
    });
  });

  it("counts failed invoice retrievals without stopping subsequent invoices", async () => {
    const { service } = createHarness(
      [page(1, ["unavailable-invoice", "valid-invoice"], false)],
      async (invoiceId) => {
        if (invoiceId === "unavailable-invoice") {
          throw new ZohoBooksApiError("sanitized", 401);
        }
        return { kind: "registered" as const, record: { id: "request-id" } };
      },
    );

    await expect(service.execute()).resolves.toMatchObject({
      state: "partial",
      paginationComplete: true,
      discovered: 2,
      imported: 1,
      failed: 1,
      issues: [
        {
          invoiceId: "unavailable-invoice",
          category: "invoice_import_failed",
          code: "ZOHO_API_ERROR",
          upstreamStatus: 401,
        },
      ],
    });
  });

  it("reports interrupted pagination as partial and never claims a full import", async () => {
    const listInvoicesPage = vi
      .fn()
      .mockResolvedValueOnce(page(1, ["invoice-1"], true))
      .mockRejectedValueOnce(new Error("network error"));
    const prepare = vi.fn().mockResolvedValue({
      kind: "registered",
      record: { id: "request-1" },
    });
    const service = new ImportZohoInvoicesService(
      { listInvoicesPage } as unknown as Pick<ZohoBooksClient, "listInvoicesPage">,
      {
        findExisting: vi.fn().mockResolvedValue(null),
        prepare,
      } as unknown as Pick<PrepareFiscalizationRequestService, "findExisting" | "prepare">,
      { pageSize: 2 },
    );

    await expect(service.execute()).resolves.toMatchObject({
      state: "partial",
      paginationComplete: false,
      discovered: 1,
      imported: 1,
      pagesRetrieved: 1,
      issues: [{ category: "invoice_list_failed", code: "INVALID_RESPONSE" }],
    });
  });

  it("stops starting additional invoices and pages after synchronization cancellation", async () => {
    const listInvoicesPage = vi
      .fn()
      .mockResolvedValueOnce(page(1, ["invoice-1", "invoice-2"], true));
    const abortController = new AbortController();
    const prepare = vi.fn(async () => {
      abortController.abort();
      return { kind: "registered" as const, record: { id: "request-1" } };
    });
    const service = new ImportZohoInvoicesService(
      { listInvoicesPage } as unknown as Pick<ZohoBooksClient, "listInvoicesPage">,
      {
        findExisting: vi.fn().mockResolvedValue(null),
        prepare,
      } as unknown as Pick<PrepareFiscalizationRequestService, "findExisting" | "prepare">,
      { pageSize: 2 },
    );

    await expect(service.execute(abortController.signal)).resolves.toMatchObject({
      state: "partial",
      paginationComplete: false,
      discovered: 2,
      imported: 1,
      issues: [{ category: "synchronization_cancelled" }],
    });
    expect(prepare).toHaveBeenCalledOnce();
    expect(listInvoicesPage).toHaveBeenCalledOnce();
  });

  it("reports an initial page failure as failed with no discovered invoices", async () => {
    const listInvoicesPage = vi.fn().mockRejectedValue(new Error("network error"));
    const prepare = vi.fn();
    const service = new ImportZohoInvoicesService(
      { listInvoicesPage } as unknown as Pick<ZohoBooksClient, "listInvoicesPage">,
      {
        findExisting: vi.fn().mockResolvedValue(null),
        prepare,
      } as unknown as Pick<PrepareFiscalizationRequestService, "findExisting" | "prepare">,
    );

    await expect(service.execute()).resolves.toMatchObject({
      state: "failed",
      paginationComplete: false,
      discovered: 0,
      imported: 0,
      failed: 0,
      issues: [{ category: "invoice_list_failed" }],
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("stops at the configured page bound when the provider never ends pagination", async () => {
    const { listInvoicesPage } = createHarness([page(1, [], true), page(2, [], true)]);
    const boundedService = new ImportZohoInvoicesService(
      { listInvoicesPage } as unknown as Pick<ZohoBooksClient, "listInvoicesPage">,
      {
        findExisting: vi.fn().mockResolvedValue(null),
        prepare: vi.fn(),
      } as unknown as Pick<PrepareFiscalizationRequestService, "findExisting" | "prepare">,
      { pageSize: 2, maxPages: 2 },
    );

    await expect(boundedService.execute()).resolves.toMatchObject({
      state: "partial",
      paginationComplete: false,
      pagesRetrieved: 2,
      issues: [{ category: "pagination_limit_reached" }],
    });
    expect(listInvoicesPage).toHaveBeenCalledTimes(2);
  });
});
