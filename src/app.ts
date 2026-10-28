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
import {
  parseNamedOperatorCredentials,
  type NamedOperatorCredential,
} from "./config/operator-api-credentials.js";
import { authenticateApiToken } from "./middleware/api-authorization.js";
import { createRateLimitMiddleware } from "./middleware/rate-limit.js";
import type { PrepareFiscalizationRequestService } from "./application/fiscalization/prepare-fiscalization-request.js";
import type { FiscalizationRepository } from "./application/fiscalization/fiscalization-repository.js";
import type { FiscalizationService } from "./application/fiscalization/fiscalization-service.js";
import type { FiscalDeviceDiagnostics } from "./application/fiscalization/fiscal-device-diagnostics.js";
import type { PrepareTremolReceiptPlan } from "./application/fiscalization/prepare-tremol-receipt-plan.js";
import type { FiscalCustomerProfileRepository } from "./application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "./application/fiscalization/fiscal-item-profile-repository.js";
import { createFiscalProfileRouter } from "./routes/fiscal-profile-routes.js";
import {
  operationalMetrics,
  safelyIncrementMetric,
  safelyObserveHttpDuration,
  type OperationalMetrics,
} from "./observability/operational-metrics.js";
import { resolveCorrelationId, runWithCorrelationId } from "./observability/request-context.js";
import { requirePermission } from "./middleware/api-authorization.js";
import type { ManualReviewService } from "./application/fiscalization/manual-review-service.js";
import type { ImportZohoInvoicesService } from "./application/zoho/import-zoho-invoices.js";
import type { ZohoInvoiceSynchronizationService } from "./application/zoho/zoho-invoice-synchronization.js";
import type { EtimsReportingService } from "./application/fiscalization/etims-reporting-service.js";
import type { FiscalizationOrchestrationService } from "./application/fiscalization/fiscalization-orchestration-service.js";
import type { EtimsReconciliationLifecycleHealth } from "./application/fiscalization/etims-reconciliation-lifecycle.js";
import type { KraProtocolReadiness } from "./integrations/etims/kra-protocol-client.js";
import type { ZohoFiscalizationWritebackService } from "./application/zoho/zoho-fiscalization-writeback-service.js";

export interface AppDependencies {
  readonly requestLogger?: Logger;
  checkDatabaseConnection?: () => Promise<void>;
  readonly databaseReadinessTimeoutMs?: number;
  readonly dependencyHealthTimeoutMs?: number;
  readonly isShuttingDown?: () => boolean;
  oauthService?: ZohoOAuthService;
  booksClient?: ZohoBooksClient;
  invoiceService?: ZohoInvoiceService;
  invoiceApiBearerToken?: string;
  operatorApiBearerToken?: string;
  readonly operatorApiCredentials?: readonly NamedOperatorCredential[];
  readonly metrics?: OperationalMetrics;
  readonly manualReviewService?: ManualReviewService;
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
  readonly etimsProtocolReadiness?: () =>
    | KraProtocolReadiness
    | {
        readonly mode: "unselected" | "oscu" | "vscu";
        readonly configured: boolean;
        readonly configurationValid?: boolean;
        readonly transportReady?: "not_checked";
        readonly contractTests?: "implemented_not_provider_verified";
        readonly contractVerified: false;
        readonly sandboxVerified?: false;
        readonly providerApproved?: false;
        readonly liveOperationPermitted: false;
        readonly blockers: readonly string[];
      };
  readonly fiscalizationOrchestrationService?: FiscalizationOrchestrationService;
  readonly etimsReconciliationHealth?: () => EtimsReconciliationLifecycleHealth & {
    readonly job: unknown;
  };
  readonly zohoWritebackService?: ZohoFiscalizationWritebackService;
}

async function boundedProbe<T>(
  check: () => Promise<T>,
  timeoutMs: number,
): Promise<
  | { readonly kind: "complete"; readonly value: T }
  | { readonly kind: "failed" }
  | { readonly kind: "timeout" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve()
      .then(check)
      .then(
        (value) => ({ kind: "complete" as const, value }),
        () => ({ kind: "failed" as const }),
      ),
    new Promise<{ readonly kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      timeout.unref();
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function createApp(dependencies: AppDependencies = {}): Express {
  const app: Express = express();
  const metrics = dependencies.metrics ?? operationalMetrics;
  const namedOperatorCredentials =
    dependencies.operatorApiCredentials ??
    (dependencies.operatorApiBearerToken !== undefined ||
    env.OPERATOR_API_CREDENTIALS_JSON === undefined
      ? []
      : parseNamedOperatorCredentials(env.OPERATOR_API_CREDENTIALS_JSON));
  const apiAuthentication = authenticateApiToken(
    dependencies.invoiceApiBearerToken ?? env.INVOICE_API_BEARER_TOKEN,
    dependencies.operatorApiBearerToken ?? env.OPERATOR_API_BEARER_TOKEN,
    namedOperatorCredentials,
  );
  const databaseReadinessTimeoutMs = dependencies.databaseReadinessTimeoutMs ?? 5_000;
  const dependencyHealthTimeoutMs = dependencies.dependencyHealthTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(databaseReadinessTimeoutMs) || databaseReadinessTimeoutMs < 1) {
    throw new Error("Database readiness timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(dependencyHealthTimeoutMs) || dependencyHealthTimeoutMs < 1) {
    throw new Error("Dependency health timeout must be a positive integer.");
  }

  app.disable("x-powered-by");

  app.use(helmet());
  app.use(
    pinoHttp.pinoHttp({
      logger: dependencies.requestLogger ?? logger,
      genReqId(request, response) {
        const correlationId = resolveCorrelationId(request.headers["x-correlation-id"]);
        response.setHeader("X-Correlation-ID", correlationId);
        return correlationId;
      },
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
  app.use((req, _res, next) => {
    const requestId = typeof req.id === "string" ? req.id : resolveCorrelationId(undefined);
    runWithCorrelationId(requestId, next);
  });
  app.use((req, res, next) => {
    const startedAt = performance.now();
    res.once("finish", () => {
      const status = res.statusCode < 400 ? "2xx" : res.statusCode < 500 ? "4xx" : "5xx";
      safelyIncrementMetric(metrics, "http_requests", status);
      safelyObserveHttpDuration(metrics, performance.now() - startedAt);
    });
    next();
  });
  app.use(
    "/integrations/zoho",
    createRateLimitMiddleware({
      windowMs: env.API_RATE_LIMIT_WINDOW_MS,
      maxRequests: env.API_RATE_LIMIT_MAX_REQUESTS,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use("/integrations/zoho", (req, res, next) => {
    if (dependencies.isShuttingDown?.() && req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Retry-After", "5");
      res.status(503).json({
        error: {
          code: "SERVER_SHUTTING_DOWN",
          message: "The service is shutting down. Retry later.",
        },
      });
      return;
    }
    next();
  });

  app.get("/health/live", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/health/ready", async (_req, res) => {
    const checkDatabaseConnection = dependencies.checkDatabaseConnection;
    if (!checkDatabaseConnection) {
      safelyIncrementMetric(metrics, "database_checks", "not_configured");
      res.status(503).json({ status: "not_ready" });
      return;
    }
    const checkResult = await boundedProbe(checkDatabaseConnection, databaseReadinessTimeoutMs);
    const ready = checkResult.kind === "complete";
    safelyIncrementMetric(metrics, "database_checks", ready ? "available" : "unavailable");
    if (ready) {
      res.status(200).json({ status: "ready" });
      return;
    }
    if (checkResult.kind === "timeout") {
      logger.error({ timeoutMs: databaseReadinessTimeoutMs }, "Database readiness check timed out");
    } else {
      logger.error("Database readiness check failed");
    }
    res.status(503).json({ status: "not_ready" });
  });
  app.get("/health/dependencies", async (_req, res) => {
    const [database, device] = await Promise.all([
      dependencies.checkDatabaseConnection
        ? boundedProbe(dependencies.checkDatabaseConnection, dependencyHealthTimeoutMs)
        : Promise.resolve({ kind: "failed" as const }),
      dependencies.fiscalDeviceDiagnostics
        ? boundedProbe(
            () => dependencies.fiscalDeviceDiagnostics!.checkConnection(),
            dependencyHealthTimeoutMs,
          )
        : Promise.resolve({ kind: "failed" as const }),
    ]);
    const databaseStatus = !dependencies.checkDatabaseConnection
      ? "not_configured"
      : database.kind === "complete"
        ? "available"
        : "unavailable";
    const deviceStatus = !dependencies.fiscalDeviceDiagnostics
      ? "not_configured"
      : device.kind === "complete" && device.value.status === "connected"
        ? "available"
        : "unavailable";
    if (dependencies.checkDatabaseConnection)
      safelyIncrementMetric(
        metrics,
        "database_checks",
        databaseStatus === "available" ? "available" : "unavailable",
      );
    if (dependencies.fiscalDeviceDiagnostics)
      safelyIncrementMetric(
        metrics,
        "device_checks",
        deviceStatus === "available" ? "available" : "unavailable",
      );
    res.status(200).json({
      status: "diagnostics_complete",
      dependencies: {
        database: databaseStatus,
        device: deviceStatus,
        zohoBooks: dependencies.booksClient ? "configured_unverified" : "not_configured",
        etims: dependencies.etimsReportingService?.getReadiness().enabled
          ? "configured_unverified"
          : "not_configured",
      },
    });
  });
  app.get("/health/integrations", (_req, res) => {
    const etims = dependencies.etimsReportingService?.getReadiness();
    const issuanceBlockers = dependencies.fiscalizationService?.getIssuanceBlockers() ?? [
      "issuance_disabled",
      "device_adapter_unavailable",
      "device_contract_unverified",
    ];
    res.status(200).json({
      zohoBooks: dependencies.booksClient ? "configured_unverified" : "not_configured",
      device: {
        diagnostics: dependencies.fiscalDeviceDiagnostics
          ? "configured_unverified"
          : "not_configured",
        receiptIssuance:
          dependencies.fiscalizationService?.getIssuanceMode() ??
          (issuanceBlockers.length === 0 ? "enabled_unverified" : "disabled"),
        blockers: issuanceBlockers,
      },
      etims: {
        enabled: etims?.enabled ?? false,
        adapter: etims?.selectedAdapterType ?? null,
        status: etims?.status ?? "not_configured",
        simulated: etims?.simulated ?? false,
        blockers: etims?.blockers ?? ["reporting_disabled", "adapter_not_selected"],
        providerHealth: "unverified",
        protocol: dependencies.etimsProtocolReadiness?.() ?? {
          mode: "unselected",
          configured: false,
          configurationValid: false,
          transportReady: "not_checked",
          contractTests: "implemented_not_provider_verified",
          contractVerified: false,
          sandboxVerified: false,
          providerApproved: false,
          liveOperationPermitted: false,
          blockers: ["adapter_not_selected"],
        },
        reconciliationWorker: dependencies.etimsReconciliationHealth?.() ?? {
          enabled: false,
          started: false,
          reason: "worker_not_registered",
          job: null,
        },
      },
      combinedWorkflow: {
        status: "blocked",
        blockers: ["legal_sequence_unverified"],
      },
    });
  });
  app.get("/health/device", async (_req, res) => {
    if (!dependencies.fiscalDeviceDiagnostics) {
      safelyIncrementMetric(metrics, "device_checks", "not_configured");
      res.status(503).json({
        status: "unavailable",
        component: "device",
      });
      return;
    }

    const probe = await boundedProbe(
      () => dependencies.fiscalDeviceDiagnostics!.checkConnection(),
      dependencyHealthTimeoutMs,
    );
    if (probe.kind !== "complete") {
      safelyIncrementMetric(metrics, "device_checks", "unavailable");
      res.status(503).json({ status: "unavailable", component: "device", reason: probe.kind });
      return;
    }
    const result = probe.value;
    safelyIncrementMetric(
      metrics,
      "device_checks",
      result.status === "connected" ? "available" : "unavailable",
    );

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
  app.get(
    "/integrations/zoho/operations/metrics",
    apiAuthentication,
    requirePermission("admin:configure"),
    (_req, res) => res.status(200).json(metrics.snapshot()),
  );
  app.use("/integrations/zoho", createZohoOAuthRouter(dependencies.oauthService));
  app.use(
    "/integrations/zoho",
    apiAuthentication,
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
    apiAuthentication,
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
      dependencies.fiscalizationOrchestrationService,
      dependencies.manualReviewService,
      metrics,
      dependencies.zohoWritebackService,
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
