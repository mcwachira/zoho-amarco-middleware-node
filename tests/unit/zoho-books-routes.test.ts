import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ZohoBooksClient } from "../../src/integrations/zoho/books-client.js";
import { ZohoBooksApiError } from "../../src/integrations/zoho/books-client.js";
import { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
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

function createTestApp(
    dependencies: Parameters<typeof createApp>[0] = {},
) {
  return createApp({
    ...dependencies,
    invoiceApiBearerToken: TEST_INVOICE_API_TOKEN,
  });
}

function authorizedRequest(
    method: "get",
    app: ReturnType<typeof createApp>,
    path: string,
) {
  return request(app)[method](path).set(
      "Authorization",
      `Bearer ${TEST_INVOICE_API_TOKEN}`,
  );
}

function createPreparationService(
    booksClient: ZohoBooksClient,
    repositoryOverrides: Partial<FiscalizationRepository> = {},
) {
  const repository = {
    create: vi.fn().mockResolvedValue(undefined),
    ...repositoryOverrides,
  } as unknown as FiscalizationRepository;

  const invoiceService = new ZohoInvoiceService(booksClient);
  const registrationService = new RegisterFiscalizationRequestService(
      repository,
  );

  const prepareService = new PrepareFiscalizationRequestService(
      invoiceService,
      registrationService,
      () => "request-123",
  );

  return { prepareService, repository };
}

describe("Zoho Books routes", () => {
  it("returns 503 when invoice retrieval is not configured", async () => {
    const app = createTestApp();

    const response = await authorizedRequest(
        "get",
        app,
        "/integrations/zoho/invoices/invoice-123",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ZOHO_BOOKS_UNAVAILABLE");
  });

  it("returns the requested invoice without fiscalizing it", async () => {
    const booksClient = createBooksClientMock();
    const app = createTestApp({ booksClient });

    const response = await authorizedRequest(
        "get",
        app,
        "/integrations/zoho/invoices/invoice-123",
    );

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

    const response = await authorizedRequest(
        "get",
        app,
        "/integrations/zoho/invoices/invoice-123",
    );

    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("ZOHO_BOOKS_UPSTREAM_ERROR");
    expect(JSON.stringify(response.body)).not.toContain(
        "Sensitive upstream details",
    );
  });

  it("returns a safe generic 500 for unexpected failures", async () => {
    const booksClient = createBooksClientMock();

    vi.mocked(booksClient.getInvoice).mockRejectedValue(
        new Error("Sensitive token or database details"),
    );

    const app = createTestApp({ booksClient });

    const response = await authorizedRequest(
        "get",
        app,
        "/integrations/zoho/invoices/invoice-123",
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(JSON.stringify(response.body)).not.toContain(
        "Sensitive token or database details",
    );
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
    expect(response.body.error.code).toBe(
        "ZOHO_INVOICE_SERVICE_UNAVAILABLE",
    );
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
        expect.arrayContaining([
          expect.objectContaining({ field: "currency_code" }),
        ]),
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
    expect(JSON.stringify(response.body)).not.toContain(
        "Sensitive upstream details",
    );
  });

  it("registers a Pending fiscalization request without issuing a receipt", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const { prepareService, repository } =
        createPreparationService(booksClient);

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
    expect(response.body.request.status).toBeTruthy();
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
      create: vi
          .fn()
          .mockRejectedValue(
              new DuplicateZohoInvoiceError("invoice-123"),
          ),
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
    expect(response.body.error.code).toBe(
        "FISCALIZATION_REQUEST_ALREADY_EXISTS",
    );
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

    const { prepareService, repository } =
        createPreparationService(booksClient);

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
    expect(response.body.error.code).toBe(
        "FISCALIZATION_REQUEST_SERVICE_UNAVAILABLE",
    );
  });

  it("rejects the endpoint without the invoice API bearer token", async () => {
    const booksClient = createValidInvoiceBooksClientMock();
    const { prepareService, repository } =
        createPreparationService(booksClient);

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
      createdAt: createdAt.toISOString(),
      updatedAt: updatedAt.toISOString(),
    });

    expect(repository.findById).toHaveBeenCalledOnce();
    expect(repository.findById).toHaveBeenCalledWith("request-123");

    // Internal failure details and device outcomes must not be exposed.
    expect(response.body.request).not.toHaveProperty("failure");
    expect(response.body.request).not.toHaveProperty("outcomeUnknownReason");
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
    expect(response.body.error.code).toBe(
        "FISCALIZATION_REPOSITORY_UNAVAILABLE",
    );
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
});