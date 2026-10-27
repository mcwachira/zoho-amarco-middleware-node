import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ZohoBooksClient } from "../../src/integrations/zoho/books-client.js";
import { ZohoBooksApiError } from "../../src/integrations/zoho/books-client.js";
import { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { FiscalizationSnapshotMissingError } from "../../src/application/fiscalization/fiscalization-snapshot.js";
import {
  FiscalizationService,
  type FiscalizationService as FiscalizationServiceType,
} from "../../src/application/fiscalization/fiscalization-service.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import type { PrepareTremolReceiptPlan } from "../../src/application/fiscalization/prepare-tremol-receipt-plan.js";
import type { ImportZohoInvoicesService } from "../../src/application/zoho/import-zoho-invoices.js";
import type { ZohoInvoiceSynchronizationService } from "../../src/application/zoho/zoho-invoice-synchronization.js";
import type { EtimsReportingService } from "../../src/application/fiscalization/etims-reporting-service.js";

import { createApp } from "../../src/app.js";

function createBooksClientMock() {
  return {
    getInvoice: vi.fn().mockResolvedValue({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "KES",
      source: {
        invoice_id: "invoice-123",
        invoice_number: "INV-001",
      },
    }),
  } as unknown as ZohoBooksClient;
}

function createValidInvoiceBooksClientMock() {
  return {
    getInvoice: vi.fn().mockResolvedValue({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "KES",
      source: {
        invoice_id: "invoice-123",
        currency_code: "KES",
        line_items: [
          {
            line_item_id: "line-1",
            item_id: "item-789",
            name: "Example product",
            quantity: 2,
            rate: 150,
            item_total: 300,
            tax_percentage: 16,
          },
        ],
        sub_total: 300,
        tax_total: 48,
        total: 348,
      },
    }),
  } as unknown as ZohoBooksClient;
}

const TEST_INVOICE_API_TOKEN = "test-invoice-api-token-for-unit-tests";

function createTestApp(dependencies: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    ...dependencies,
    invoiceApiBearerToken: TEST_INVOICE_API_TOKEN,
  });
}

function authorizedRequest(
  method: "get" | "post",
  app: ReturnType<typeof createApp>,
  path: string,
) {
  return request(app)[method](path).set("Authorization", `Bearer ${TEST_INVOICE_API_TOKEN}`);
}

function createPreparationService(
  booksClient: ZohoBooksClient,
  repositoryOverrides: Partial<FiscalizationRepository> = {},
) {
  const repository = {
    findByZohoInvoiceId: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue(undefined),
    ...repositoryOverrides,
  } as unknown as FiscalizationRepository;

  const invoiceService = new ZohoInvoiceService(booksClient);
  const registrationService = new RegisterFiscalizationRequestService(repository);

  const prepareService = new PrepareFiscalizationRequestService(
    invoiceService,
    registrationService,
    {
      zohoOrganizationId: "organization-1",
      generateId: () => "request-123",
      customerProfiles: {
        findByZohoCustomerId: vi.fn().mockResolvedValue({
          id: "customer-profile-1",
          zohoCustomerId: "customer-456",
          companyName: "Example Ltd",
          clientPin: "P051234567X",
          headquarters: "Nairobi",
          address: "Main Road",
          postalCodeAndCity: "00100 Nairobi",
          exemptionNumber: null,
          createdAt: new Date("2026-10-26T00:00:00.000Z"),
          updatedAt: new Date("2026-10-26T00:00:00.000Z"),
        }),
      },
      itemProfiles: {
        findByZohoItemId: vi.fn().mockResolvedValue({
          id: "item-profile-1",
          zohoItemId: "item-789",
          measureUnit: "EA",
          hsCode: "1234.56.78",
          hsName: "Example product",
          vatClass: "A",
          vatGroupRate: "16.00",
          createdAt: new Date("2026-10-26T00:00:00.000Z"),
          updatedAt: new Date("2026-10-26T00:00:00.000Z"),
        }),
      },
    },
  );

  return { prepareService, repository };
}

describe("Zoho Books routes", () => {
  it("runs invoice import independently of fiscalization processing", async () => {
    const execute = vi.fn().mockResolvedValue({
      state: "completed",
      paginationComplete: true,
      discovered: 2,
      imported: 1,
      duplicatesSkipped: 1,
      rejected: 0,
      failed: 0,
      pagesRetrieved: 1,
      issues: [],
    });
    const app = createTestApp({
      invoiceImportService: { execute } as unknown as ImportZohoInvoicesService,
    });

    const response = await authorizedRequest("post", app, "/integrations/zoho/invoices/import");

    expect(response.status).toBe(200);
    expect(response.body.import).toMatchObject({
      state: "completed",
      discovered: 2,
      imported: 1,
      duplicatesSkipped: 1,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not report a partial invoice import as fully successful", async () => {
    const execute = vi.fn().mockResolvedValue({
      state: "partial",
      paginationComplete: false,
      discovered: 1,
      imported: 1,
      duplicatesSkipped: 0,
      rejected: 0,
      failed: 0,
      pagesRetrieved: 1,
      issues: [{ category: "invoice_list_failed", code: "ZOHO_TRANSPORT_ERROR" }],
    });
    const app = createTestApp({
      invoiceImportService: { execute } as unknown as ImportZohoInvoicesService,
    });

    const response = await authorizedRequest("post", app, "/integrations/zoho/invoices/import");

    expect(response.status).toBe(207);
    expect(response.body.import.paginationComplete).toBe(false);
    expect(response.body.import.issues).toEqual([
      { category: "invoice_list_failed", code: "ZOHO_TRANSPORT_ERROR" },
    ]);
  });

  it("uses the durable synchronizer for manual imports and reports an active run as busy", async () => {
    const execute = vi.fn().mockResolvedValue({ state: "busy", run: null });
    const importer = { execute: vi.fn() } as unknown as ImportZohoInvoicesService;
    const synchronizer = {
      execute,
      getStatus: vi.fn(),
    } as unknown as ZohoInvoiceSynchronizationService;
    const app = createTestApp({
      invoiceImportService: importer,
      zohoInvoiceSynchronizationService: synchronizer,
    });

    const response = await authorizedRequest("post", app, "/integrations/zoho/invoices/import");

    expect(response.status).toBe(409);
    expect(response.body.synchronization.state).toBe("busy");
    expect(execute).toHaveBeenCalledOnce();
    expect(importer.execute).not.toHaveBeenCalled();
  });

  it("authenticates synchronization status and exposes only sanitized operational fields", async () => {
    const getStatus = vi.fn().mockResolvedValue({
      organizationId: "organization-1",
      inProgress: false,
      lockExpiresAt: null,
      latestRun: {
        id: "run-1",
        status: "Failed",
        errorCode: "ZOHO_API_ERROR",
        discovered: 4,
        imported: 2,
      },
      lastSuccessfulFullSyncAt: null,
      checkpointMode: "full_catalog_scan",
      automaticSyncEnabled: false,
    });
    const synchronizer = {
      execute: vi.fn(),
      getStatus,
    } as unknown as ZohoInvoiceSynchronizationService;
    const app = createTestApp({ zohoInvoiceSynchronizationService: synchronizer });

    const unauthorized = await request(app).get("/integrations/zoho/invoices/sync/status");
    expect(unauthorized.status).toBe(401);

    const response = await authorizedRequest("get", app, "/integrations/zoho/invoices/sync/status");
    expect(response.status).toBe(200);
    expect(response.body.synchronization).toMatchObject({
      inProgress: false,
      checkpointMode: "full_catalog_scan",
      latestRun: { errorCode: "ZOHO_API_ERROR", discovered: 4, imported: 2 },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /accessToken|refreshToken|clientSecret|leaseToken/i,
    );
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("returns 503 when invoice retrieval is not configured", async () => {
    const app = createTestApp();

    const response = await authorizedRequest("get", app, "/integrations/zoho/invoices/invoice-123");

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ZOHO_BOOKS_UNAVAILABLE");
  });

  it("returns the requested invoice without fiscalizing it", async () => {
    const booksClient = createBooksClientMock();
    const app = createTestApp({ booksClient });

    const response = await authorizedRequest("get", app, "/integrations/zoho/invoices/invoice-123");

    expect(response.status).toBe(200);
    expect(response.body.invoice).toMatchObject({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "KES",
    });

    expect(booksClient.getInvoice).toHaveBeenCalledOnce();
    expect(booksClient.getInvoice).toHaveBeenCalledWith("invoice-123");
  });

  it("returns a generic 502 when Zoho Books rejects the request", async () => {
    const booksClient = createBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockRejectedValue(
      new ZohoBooksApiError("Sensitive upstream details", 401),
    );

    const app = createTestApp({ booksClient });

    const response = await authorizedRequest("get", app, "/integrations/zoho/invoices/invoice-123");

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("ZOHO_BOOKS_UPSTREAM_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("Sensitive upstream details");
  });

  it("returns a safe generic 500 for unexpected failures", async () => {
    const booksClient = createBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockRejectedValue(
      new Error("Sensitive token or database details"),
    );

    const app = createTestApp({ booksClient });

    const response = await authorizedRequest("get", app, "/integrations/zoho/invoices/invoice-123");

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("Sensitive token or database details");
  });

  it("returns a mapped fiscal candidate without fiscalizing the invoice", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const invoiceService = new ZohoInvoiceService(booksClient);
    const app = createTestApp({ booksClient, invoiceService });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscal-candidate",
    );

    expect(response.status).toBe(200);
    expect(response.body.candidate).toMatchObject({
      zohoInvoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      currencyCode: "KES",
      subtotal: "300",
      taxTotal: "48",
      total: "348",
    });

    expect(booksClient.getInvoice).toHaveBeenCalledOnce();
  });

  it("returns 503 when invoice mapping is not configured", async () => {
    const app = createTestApp();

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscal-candidate",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ZOHO_INVOICE_SERVICE_UNAVAILABLE");
  });

  it("returns mapping errors when the retrieved invoice is invalid", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockResolvedValue({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "",
      source: {
        invoice_id: "invoice-123",
        currency_code: "",
        line_items: [{ quantity: 1, rate: 10, item_total: 10 }],
        sub_total: 10,
        tax_total: 0,
        total: 10,
      },
    });

    const invoiceService = new ZohoInvoiceService(booksClient);
    const app = createTestApp({ booksClient, invoiceService });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscal-candidate",
    );

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("ZOHO_INVOICE_MAPPING_FAILED");
    expect(response.body.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "currency_code" })]),
    );
  });

  it("returns a generic upstream error when Zoho retrieval fails", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockRejectedValue(
      new ZohoBooksApiError("Sensitive upstream details", 401),
    );

    const invoiceService = new ZohoInvoiceService(booksClient);
    const app = createTestApp({ booksClient, invoiceService });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscal-candidate",
    );

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("ZOHO_BOOKS_UPSTREAM_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("Sensitive upstream details");
  });

  it("registers a Pending fiscalization request without issuing a receipt", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const { prepareService, repository } = createPreparationService(booksClient);

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareFiscalizationRequestService: prepareService,
    });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscalization-requests",
    );

    expect(response.status).toBe(201);
    expect(response.body.request).toMatchObject({
      id: "request-123",
      zohoInvoiceId: "invoice-123",
    });
    expect(response.body.request.status).toBe("Pending");
    expect(booksClient.getInvoice).toHaveBeenCalledOnce();
    expect(repository.create).toHaveBeenCalledOnce();
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "request-123",
        zohoInvoiceId: "invoice-123",
      }),
    );
    expect(booksClient.getInvoice).toHaveBeenCalledWith("invoice-123");
  });

  it("returns 409 when the invoice has already been registered", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    const { prepareService } = createPreparationService(booksClient, {
      create: vi.fn().mockRejectedValue(new DuplicateZohoInvoiceError("invoice-123")),
    });

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareFiscalizationRequestService: prepareService,
    });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscalization-requests",
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FISCALIZATION_REQUEST_ALREADY_EXISTS");
  });

  it("does not register an invoice that fails mapping", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockResolvedValue({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "",
      source: {
        invoice_id: "invoice-123",
        currency_code: "",
        line_items: [{ quantity: 1, rate: 10, item_total: 10 }],
        sub_total: 10,
        tax_total: 0,
        total: 10,
      },
    });

    const { prepareService, repository } = createPreparationService(booksClient);

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareFiscalizationRequestService: prepareService,
    });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscalization-requests",
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("ZOHO_INVOICE_MAPPING_FAILED");
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("returns 503 when request preparation is not configured", async () => {
    const app = createTestApp();

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/invoices/invoice-123/fiscalization-requests",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FISCALIZATION_REQUEST_SERVICE_UNAVAILABLE");
  });

  it("rejects the endpoint without the invoice API bearer token", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const { prepareService, repository } = createPreparationService(booksClient);

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareFiscalizationRequestService: prepareService,
    });

    const response = await request(app).post(
      "/integrations/zoho/invoices/invoice-123/fiscalization-requests",
    );

    expect(response.status).toBe(401);
    expect(repository.create).not.toHaveBeenCalled();
    expect(booksClient.getInvoice).not.toHaveBeenCalled();
  });

  it("returns the public status of an existing fiscalization request", async () => {
    const createdAt = new Date("2026-10-21T09:00:00.000Z");
    const updatedAt = new Date("2026-10-21T09:05:00.000Z");

    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-123",
        zohoInvoiceId: "invoice-123",
        status: "Pending",
        createdAt,
        updatedAt,
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: null,
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const app = createTestApp({ fiscalizationRepository: repository });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/fiscalization-requests/request-123",
    );

    expect(response.status).toBe(200);
    expect(response.body.request).toEqual({
      id: "request-123",
      zohoInvoiceId: "invoice-123",
      status: "Pending",
      processingOutcome: {
        state: "pending",
        reconciliationRequired: false,
      },
      issuance: {
        enabled: false,
        blockedBy: [
          "issuance_disabled",
          "payment_source_unverified",
          "tax_rules_unverified",
          "device_contract_unverified",
          "device_adapter_unavailable",
        ],
      },
      integrations: {
        etims: "not_configured",
        etimsBlockedBy: [
          "vscu_runtime_not_configured",
          "submission_transport_authentication_unverified",
          "invoice_and_tax_mapping_incomplete",
          "verified_receipt_lifecycle_unavailable",
          "duplicate_reconciliation_unverified",
        ],
        etimsReporting: null,
        zohoWriteBack: "not_configured",
      },
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
      snapshot: { present: false, valid: false, version: null },
      receipt: null,
      failure: null,
      outcomeUnknown: false,
      processingInProgress: false,
      reconciliationRequired: false,
      operatorReviewRequired: true,
    });

    expect(repository.findById).toHaveBeenCalledOnce();
    expect(repository.findById).toHaveBeenCalledWith("request-123");

    // Internal failure details and device outcomes must not be exposed.
    expect(response.body.request.failure).toBeNull();
    expect(response.body.request).not.toHaveProperty("outcomeUnknownReason");
  });

  it("reports an unknown outcome and review requirement without exposing its reason", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-unknown",
        zohoInvoiceId: "invoice-123",
        status: "OutcomeUnknown",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: new Date("2026-10-21T09:05:00.000Z"),
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: null,
        outcomeUnknownReason: "Raw device payload and internal diagnostic",
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-unknown",
    );

    expect(response.status).toBe(200);
    expect(response.body.request).toMatchObject({
      status: "OutcomeUnknown",
      snapshot: { present: false, valid: false, version: null },
      integrations: {
        etims: "not_configured",
        etimsBlockedBy: expect.any(Array),
        zohoWriteBack: "not_configured",
      },
      outcomeUnknown: true,
      processingInProgress: false,
      reconciliationRequired: true,
      operatorReviewRequired: true,
    });
    expect(JSON.stringify(response.body)).not.toContain("Raw device payload");
  });

  it("reports active processing without claiming it is stale or failed", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-processing",
        zohoInvoiceId: "invoice-123",
        status: "InProgress",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: new Date("2026-10-21T09:05:00.000Z"),
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: null,
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-processing",
    );

    expect(response.status).toBe(200);
    expect(response.body.request).toMatchObject({
      status: "InProgress",
      processingOutcome: {
        state: "processing",
        reconciliationRequired: false,
      },
      issuance: {
        enabled: false,
        blockedBy: expect.arrayContaining([
          "payment_source_unverified",
          "tax_rules_unverified",
          "device_contract_unverified",
        ]),
      },
      integrations: {
        etims: "not_configured",
        etimsBlockedBy: expect.any(Array),
        zohoWriteBack: "not_configured",
      },
      processingInProgress: true,
      reconciliationRequired: false,
      operatorReviewRequired: true,
      failure: null,
      receipt: null,
    });
  });

  it("returns confirmed receipt metadata only for a succeeded request", async () => {
    const issuedAt = new Date("2026-10-21T09:05:00.000Z");
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-succeeded",
        zohoInvoiceId: "invoice-123",
        status: "Succeeded",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: issuedAt,
        snapshot: null,
        snapshotVersion: null,
        receipt: { receiptNumber: "R-123", issuedAt },
        failure: null,
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-succeeded",
    );

    expect(response.status).toBe(200);
    expect(response.body.request.integrations).toMatchObject({
      etims: "not_configured",
      etimsBlockedBy: expect.arrayContaining([
        "verified_receipt_lifecycle_unavailable",
        "duplicate_reconciliation_unverified",
      ]),
      zohoWriteBack: "not_configured",
    });
    expect(response.body.request.receipt).toEqual({
      receiptNumber: "R-123",
      issuedAt: issuedAt.toISOString(),
    });
    expect(response.body.request.outcomeUnknown).toBe(false);
  });

  it("keeps an accepted eTIMS result independent from a pending Tremol request", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-pending",
        zohoInvoiceId: "invoice-123",
        status: "Pending",
        createdAt: new Date("2026-10-27T06:00:00.000Z"),
        updatedAt: new Date("2026-10-27T06:00:00.000Z"),
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: null,
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;
    const etimsReportingService = {
      getReadiness: () => ({
        enabled: true,
        selectedAdapterType: "vscu",
        status: "blocked",
        blockers: ["verified_receipt_lifecycle_unavailable"],
        capabilities: {
          supportsReconciliation: false,
          safeResubmissionAfterConfirmedNotFound: false,
        },
      }),
      getByFiscalizationRequestId: vi.fn().mockResolvedValue({
        operation: {
          id: "etims-operation-1",
          fiscalizationRequestId: "request-pending",
          zohoInvoiceId: "invoice-123",
          adapterType: "vscu",
          adapterConfigurationId: null,
          correlationId: "correlation-1",
          status: "accepted",
          payloadHash: "a".repeat(64),
          attemptNumber: 1,
          providerReference: "kra-ref-1",
          providerMetadataJson: null,
          errorCategory: null,
          errorMessage: null,
          reconciliationRequired: false,
          createdAt: new Date("2026-10-27T06:00:00.000Z"),
          updatedAt: new Date("2026-10-27T06:01:00.000Z"),
        },
        attempts: [{}],
      }),
    } as unknown as EtimsReportingService;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository, etimsReportingService }),
      "/integrations/zoho/fiscalization-requests/request-pending",
    );

    expect(response.status).toBe(200);
    expect(response.body.request.status).toBe("Pending");
    expect(response.body.request.receipt).toBeNull();
    expect(response.body.request.integrations.etims).toBe("accepted");
    expect(response.body.request.integrations.etimsReporting).toMatchObject({
      status: "accepted",
      adapterType: "vscu",
      attemptNumber: 1,
      reconciliationRequired: false,
    });
  });

  it("returns only safe failure information and redacts persisted messages", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-failed",
        zohoInvoiceId: "invoice-123",
        status: "Failed",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: new Date("2026-10-21T09:05:00.000Z"),
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: {
          code: "DEVICE_REJECTED",
          message: "private token and raw device response",
        },
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-failed",
    );

    expect(response.status).toBe(200);
    expect(response.body.request.failure).toEqual({
      code: "DEVICE_REJECTED",
      message:
        "The fiscalization operation was confirmed as failed. Review the request before taking further action.",
    });
    expect(JSON.stringify(response.body)).not.toContain("private token");
    expect(JSON.stringify(response.body)).not.toContain("raw device response");
  });

  it("does not return an unrecognized persisted failure code", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-failed-unrecognized",
        zohoInvoiceId: "invoice-123",
        status: "Failed",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: new Date("2026-10-21T09:05:00.000Z"),
        snapshot: null,
        snapshotVersion: null,
        receipt: null,
        failure: { code: "PRIVATE_TOKEN_VALUE", message: "private diagnostic" },
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-failed-unrecognized",
    );

    expect(response.status).toBe(200);
    expect(response.body.request.failure.code).toBe("FISCALIZATION_FAILED");
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE_TOKEN_VALUE");
  });

  it("marks malformed stored snapshots for operator review without returning snapshot data", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue({
        id: "request-legacy",
        zohoInvoiceId: "invoice-123",
        status: "Pending",
        createdAt: new Date("2026-10-21T09:00:00.000Z"),
        updatedAt: new Date("2026-10-21T09:00:00.000Z"),
        snapshot: { sensitive: "invoice/customer details" },
        snapshotVersion: 999,
        receipt: null,
        failure: null,
        outcomeUnknownReason: null,
      }),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-legacy",
    );

    expect(response.status).toBe(200);
    expect(response.body.request.snapshot).toEqual({
      present: true,
      valid: false,
      version: 999,
    });
    expect(response.body.request.operatorReviewRequired).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("invoice/customer details");
  });

  it("returns 404 when a fiscalization request does not exist", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as FiscalizationRepository;

    const app = createTestApp({ fiscalizationRepository: repository });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/fiscalization-requests/missing-request",
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("FISCALIZATION_REQUEST_NOT_FOUND");
    expect(repository.findById).toHaveBeenCalledWith("missing-request");
  });

  it("returns 503 when fiscalization request lookup is not configured", async () => {
    const app = createTestApp();

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/fiscalization-requests/request-123",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FISCALIZATION_REPOSITORY_UNAVAILABLE");
  });

  it("returns a safe error when fiscalization status lookup fails", async () => {
    const repository = {
      findById: vi.fn().mockRejectedValue(new Error("database URL and private details")),
    } as unknown as FiscalizationRepository;

    const response = await authorizedRequest(
      "get",
      createTestApp({ fiscalizationRepository: repository }),
      "/integrations/zoho/fiscalization-requests/request-123",
    );

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    });
    expect(JSON.stringify(response.body)).not.toContain("database URL");
  });

  it("rejects fiscalization status lookup without the bearer token", async () => {
    const repository = {
      findById: vi.fn().mockResolvedValue(null),
    } as unknown as FiscalizationRepository;

    const app = createTestApp({ fiscalizationRepository: repository });

    const response = await request(app).get(
      "/integrations/zoho/fiscalization-requests/request-123",
    );

    expect(response.status).toBe(401);
    expect(repository.findById).not.toHaveBeenCalled();
  });

  it("returns 503 without retrieving the invoice when fiscalization processing is not configured", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const invoiceService = new ZohoInvoiceService(booksClient);

    const repository = {
      findById: vi.fn(),
    } as unknown as FiscalizationRepository;

    // Deliberately omit fiscalizationService to simulate an
    // application without a verified fiscal-device implementation.
    const app = createTestApp({
      booksClient,
      invoiceService,
      fiscalizationRepository: repository,
    });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/fiscalization-requests/request-123/process",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FISCALIZATION_PROCESSING_UNAVAILABLE");

    // The configuration guard must run before database or Zoho access.
    expect(repository.findById).not.toHaveBeenCalled();
    expect(booksClient.getInvoice).not.toHaveBeenCalled();
  });

  it("blocks wired fiscalization before repository or device access", async () => {
    const repository = {
      findById: vi.fn(),
      claimPending: vi.fn(),
    } as unknown as FiscalizationRepository;
    const device = { issueReceipt: vi.fn() };
    const fiscalizationService = new FiscalizationService(repository, device, "organization-1");

    const response = await authorizedRequest(
      "post",
      createTestApp({ fiscalizationService }),
      "/integrations/zoho/fiscalization-requests/request-123/process",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("FISCALIZATION_ISSUANCE_DISABLED");
    expect(response.body.blockedBy).toContain("payment_source_unverified");
    expect(repository.findById).not.toHaveBeenCalled();
    expect(repository.claimPending).not.toHaveBeenCalled();
    expect(device.issueReceipt).not.toHaveBeenCalled();
  });

  it("processes a registered request without fetching the current Zoho invoice", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const completedAt = new Date("2026-10-27T00:00:00.000Z");
    const fiscalizationService = {
      fiscalize: vi.fn().mockResolvedValue({
        id: "request-123",
        zohoInvoiceId: "invoice-123",
        status: "Succeeded",
        createdAt: completedAt,
        updatedAt: completedAt,
      }),
    } as unknown as FiscalizationServiceType;
    const app = createTestApp({ booksClient, fiscalizationService });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/fiscalization-requests/request-123/process",
    );

    expect(response.status).toBe(200);
    expect(fiscalizationService.fiscalize).toHaveBeenCalledWith({ id: "request-123" });
    expect(booksClient.getInvoice).not.toHaveBeenCalled();
  });

  it("requires operator review for a legacy request without refetching Zoho inputs", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const fiscalizationService = {
      fiscalize: vi.fn().mockRejectedValue(new FiscalizationSnapshotMissingError()),
    } as unknown as FiscalizationServiceType;
    const app = createTestApp({ booksClient, fiscalizationService });

    const response = await authorizedRequest(
      "post",
      app,
      "/integrations/zoho/fiscalization-requests/legacy-request/process",
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FISCALIZATION_SNAPSHOT_REQUIRED");
    expect(booksClient.getInvoice).not.toHaveBeenCalled();
  });

  it("returns a non-executable Tremol receipt plan without fiscalizing", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const invoiceService = new ZohoInvoiceService(booksClient);
    const plan = { executable: false, commands: [] };

    const prepareTremolReceiptPlan = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        plan,
      }),
    } as unknown as PrepareTremolReceiptPlan;

    const app = createTestApp({
      booksClient,
      invoiceService,
      prepareTremolReceiptPlan,
    });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/tremol-receipt-plan",
    );

    expect(response.status).toBe(200);
    expect(response.body.plan).toEqual(plan);
    expect(response.body.plan.executable).toBe(false);
    expect(prepareTremolReceiptPlan.execute).toHaveBeenCalledOnce();
    expect(booksClient.getInvoice).toHaveBeenCalledOnce();
  });

  it("returns 503 when Tremol receipt-plan preparation is not configured", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
    });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/tremol-receipt-plan",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("TREMOL_RECEIPT_PLAN_UNAVAILABLE");
    expect(booksClient.getInvoice).not.toHaveBeenCalled();
  });

  it("returns 422 when the invoice cannot be mapped", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockResolvedValue({
      invoiceId: "invoice-123",
      invoiceNumber: "INV-001",
      customerId: "customer-456",
      customerName: "Example Customer",
      currencyCode: "",
      source: {
        invoice_id: "invoice-123",
        currency_code: "",
        line_items: [{ quantity: 1, rate: 10, item_total: 10 }],
        sub_total: 10,
        tax_total: 0,
        total: 10,
      },
    });

    const prepareTremolReceiptPlan = {
      execute: vi.fn(),
    } as unknown as PrepareTremolReceiptPlan;

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareTremolReceiptPlan,
    });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/tremol-receipt-plan",
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("ZOHO_INVOICE_MAPPING_FAILED");
    expect(prepareTremolReceiptPlan.execute).not.toHaveBeenCalled();
  });

  it("returns 422 when fiscal metadata validation fails", async () => {
    const booksClient = createValidInvoiceBooksClientMock();

    const prepareTremolReceiptPlan = {
      execute: vi.fn().mockResolvedValue({
        success: false,
        errors: [
          {
            field: "customer",
            message: "No fiscal profile is configured for this Zoho customer.",
          },
        ],
      }),
    } as unknown as PrepareTremolReceiptPlan;

    const app = createTestApp({
      booksClient,
      invoiceService: new ZohoInvoiceService(booksClient),
      prepareTremolReceiptPlan,
    });

    const response = await authorizedRequest(
      "get",
      app,
      "/integrations/zoho/invoices/invoice-123/tremol-receipt-plan",
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("TREMOL_RECEIPT_PLAN_VALIDATION_FAILED");
    expect(response.body.details).toEqual([
      {
        field: "customer",
        message: "No fiscal profile is configured for this Zoho customer.",
      },
    ]);
    expect(prepareTremolReceiptPlan.execute).toHaveBeenCalledOnce();
  });
});
