import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import * as pinoHttp from "pino-http";
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

export interface AppDependencies {
  checkDatabaseConnection?: () => Promise<void>;
  oauthService?: ZohoOAuthService;
  booksClient?: ZohoBooksClient;
  invoiceService?: ZohoInvoiceService;
  invoiceApiBearerToken?: string;
  prepareFiscalizationRequestService?: PrepareFiscalizationRequestService;
  fiscalizationRepository?: FiscalizationRepository;
  readonly fiscalizationService?: FiscalizationService;
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app: Express = express();

  app.disable("x-powered-by");

  app.use(helmet());
  app.use(pinoHttp.pinoHttp({ logger }));
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
    } catch (error) {
      logger.error({ err: error }, "Database readiness check failed");
      res.status(503).json({ status: "not_ready" });
    }
  });

  app.use("/integrations/zoho", createZohoOAuthRouter(dependencies.oauthService));
  app.use(
    "/integrations/zoho",
    requireInvoiceApiToken(dependencies.invoiceApiBearerToken ?? env.INVOICE_API_BEARER_TOKEN),
    createZohoBooksRouter(
      dependencies.booksClient,
      dependencies.invoiceService,
      dependencies.prepareFiscalizationRequestService,
      dependencies.fiscalizationRepository,
      dependencies.fiscalizationService,
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

    req.log.error({ err: error }, "Unhandled request error");
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
