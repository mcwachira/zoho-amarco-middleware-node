import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import * as pinoHttp from "pino-http";
import type { Logger } from "pino";
import { logger } from "./observability/logger.js";
import type { ZohoOAuthService } from "./application/zoho/zoho-oauth-service.js";
import { createZohoOAuthRouter } from "./routes/zoho-oauth-routes.js";
import type { ZohoBooksClient } from "./integrations/zoho/books-client.js";
import { createZohoBooksRouter } from "./routes/zoho-books-routes.js";
import type { ZohoInvoiceService } from "./application/zoho/zoho-invoice-service.js";
import { env } from "./config/env.js";
import { requireInvoiceApiToken } from "./middleware/require-invoice-api-token.js";
import type { PrepareFiscalizationRequestService } from "./application/fiscalization/prepare-fiscalization-request.js";
import type { FiscalizationRepository } from "./application/fiscalization/fiscalization-repository.js";
import type { FiscalizationService } from "./application/fiscalization/fiscalization-service.js";
import type { FiscalDeviceDiagnostics } from "./application/fiscalization/fiscal-device-diagnostics.js";
import type { PrepareTremolReceiptPlan } from "./application/fiscalization/prepare-tremol-receipt-plan.js";
import type { FiscalCustomerProfileRepository } from "./application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "./application/fiscalization/fiscal-item-profile-repository.js";
import { createFiscalProfileRouter } from "./routes/fiscal-profile-routes.js";
import type { ImportZohoInvoicesService } from "./application/zoho/import-zoho-invoices.js";
import type { ZohoInvoiceSynchronizationService } from "./application/zoho/zoho-invoice-synchronization.js";
import type { EtimsReportingService } from "./application/fiscalization/etims-reporting-service.js";

export interface AppDependencies {
  readonly requestLogger?: Logger;
  checkDatabaseConnection?: () => Promise<void>;
  oauthService?: ZohoOAuthService;
  booksClient?: ZohoBooksClient;
  invoiceService?: ZohoInvoiceService;
  invoiceApiBearerToken?: string;
  prepareFiscalizationRequestService?: PrepareFiscalizationRequestService;
  fiscalizationRepository?: FiscalizationRepository;
  readonly fiscalizationService?: FiscalizationService;
  readonly fiscalDeviceDiagnostics?: FiscalDeviceDiagnostics;
  prepareTremolReceiptPlan?: PrepareTremolReceiptPlan;
  readonly fiscalCustomerProfileRepository?: FiscalCustomerProfileRepository;
  readonly fiscalItemProfileRepository?: FiscalItemProfileRepository;
  readonly invoiceImportService?: ImportZohoInvoicesService;
  readonly zohoInvoiceSynchronizationService?: ZohoInvoiceSynchronizationService;
  readonly etimsReportingService?: EtimsReportingService;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app: Express = express();

  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    pinoHttp.pinoHttp({
      logger: dependencies.requestLogger ?? logger,
      serializers: {
        req(request) {
          let requestPath = "[unavailable]";
          try {
            requestPath = new URL(request.url ?? "/", "http://localhost").pathname;
          } catch {
            // Do not fall back to the raw URL, which may contain secrets.
          }
          const requestId =
            "id" in request && (typeof request.id === "string" || typeof request.id === "number")
              ? request.id
              : undefined;

          return {
            ...(requestId !== undefined ? { id: requestId } : {}),
            method: request.method,
            url: requestPath,
          };
        },
        res(response) {
          return { statusCode: response.statusCode };
        },
        err() {
          return { type: "RequestError" };
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health/ready", async (_req, res) => {
    if (!dependencies.checkDatabaseConnection) {
      res.status(503).json({ status: "not_ready" });
      return;
    }
    try {
      await dependencies.checkDatabaseConnection();
      res.status(200).json({ status: "ready" });
    } catch {
      logger.error("Database readiness check failed");
      res.status(503).json({ status: "not_ready" });
    }
  });
  app.get("/health/device", async (_req, res) => {
    if (!dependencies.fiscalDeviceDiagnostics) {
      res.status(503).json({
        status: "unavailable",
        component: "device",
      });
      return;
    }

    const result = await dependencies.fiscalDeviceDiagnostics.checkConnection();

    if (result.status === "connected") {
      res.status(200).json({
        status: "connected",
        component: "device",
      });
      return;
    }

    res.status(503).json({
      status: "unavailable",
      component: "device",
      reason: result.reason,
    });
  });
  app.use("/integrations/zoho", createZohoOAuthRouter(dependencies.oauthService));
  app.use(
    "/integrations/zoho",
    requireInvoiceApiToken(dependencies.invoiceApiBearerToken ?? env.INVOICE_API_BEARER_TOKEN),
    createFiscalProfileRouter({
      ...(dependencies.fiscalCustomerProfileRepository
        ? { customerRepository: dependencies.fiscalCustomerProfileRepository }
        : {}),
      ...(dependencies.fiscalItemProfileRepository
        ? { itemRepository: dependencies.fiscalItemProfileRepository }
        : {}),
    }),
  );
  app.use(
    "/integrations/zoho",
    requireInvoiceApiToken(dependencies.invoiceApiBearerToken ?? env.INVOICE_API_BEARER_TOKEN),
    createZohoBooksRouter(
      dependencies.booksClient,
      dependencies.invoiceService,
      dependencies.prepareFiscalizationRequestService,
      dependencies.fiscalizationRepository,
      dependencies.fiscalizationService,
      dependencies.prepareTremolReceiptPlan,
      dependencies.invoiceImportService,
      dependencies.zohoInvoiceSynchronizationService,
      dependencies.etimsReportingService,
    ),
  );

  app.use((_req, res) => {
    res.status(404).json({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.parse.failed"
    ) {
      res.status(400).json({
        error: {
          code: "INVALID_JSON",
          message: "The request body must contain valid JSON.",
        },
      });
      return;
    }

    req.log.error("Unhandled request error");
    res.status(500).json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred.",
      },
    });
  };

  app.use(errorHandler);

  return app;
}

// Keeps the app importable by existing tests and callers.
export const app: Express = createApp();
