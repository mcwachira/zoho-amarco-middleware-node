import { Router } from "express";
import { z } from "zod";
import { getApiIdentity, requirePermission } from "../middleware/api-authorization.js";
import type { ZohoInvoiceService } from "../application/zoho/zoho-invoice-service.js";
import {
  ZohoBooksApiError,
  ZohoBooksAuthorizationError,
  ZohoBooksResponseError,
  ZohoBooksTransportError,
  type ZohoBooksClient,
} from "../integrations/zoho/books-client.js";
import type { PrepareFiscalizationRequestService } from "../application/fiscalization/prepare-fiscalization-request.js";
import {
  DuplicateZohoInvoiceError,
  FiscalizationRequestPersistenceError,
} from "../application/fiscalization/fiscalization-errors.js";
import {
  FiscalizationClaimError,
  FiscalizationPersistenceError,
  FiscalizationRequestNotFoundError,
  FiscalizationIssuanceDisabledError,
  FiscalDeviceNotReadyError,
} from "../application/fiscalization/fiscalization-service.js";
import type { FiscalizationService } from "../application/fiscalization/fiscalization-service.js";
import type { FiscalizationRepository } from "../application/fiscalization/fiscalization-repository.js";
import type { PrepareTremolReceiptPlan } from "../application/fiscalization/prepare-tremol-receipt-plan.js";
import {
  FiscalizationSnapshotError,
  FiscalizationSnapshotMissingError,
  UnsupportedFiscalizationSnapshotVersionError,
  parseFiscalizationSnapshot,
} from "../application/fiscalization/fiscalization-snapshot.js";
import type { ImportZohoInvoicesService } from "../application/zoho/import-zoho-invoices.js";
import type { ZohoInvoiceSynchronizationService } from "../application/zoho/zoho-invoice-synchronization.js";
import type { ZohoFiscalizationWritebackService } from "../application/zoho/zoho-fiscalization-writeback-service.js";
import { ZohoFiscalizationWritebackNotFoundError } from "../application/zoho/zoho-fiscalization-writeback-service.js";
import {
  ETIMS_REPORTING_BLOCKERS,
  ETIMS_REPORTING_STATUS,
} from "../domain/fiscalization/etims-reporting-status.js";
import type { EtimsReportingService } from "../application/fiscalization/etims-reporting-service.js";
import type { FiscalizationOrchestrationService } from "../application/fiscalization/fiscalization-orchestration-service.js";
import { FiscalizationMappingConfigurationConflictError } from "../application/fiscalization/fiscalization-orchestration-service.js";
import {
  ManualReviewConflictError,
  type ManualReviewService,
} from "../application/fiscalization/manual-review-service.js";
import {
  operationalMetrics,
  safelyIncrementMetric,
  type OperationalMetrics,
} from "../observability/operational-metrics.js";

function isValidStoredSnapshot(snapshot: unknown, version: number | null): boolean {
  try {
    parseFiscalizationSnapshot(snapshot, version);
    return true;
  } catch {
    return false;
  }
}

function isValidZohoIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function zohoInvoiceRequestFailure(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
} | null {
  if (error instanceof ZohoBooksAuthorizationError) {
    return {
      status: 503,
      code: "ZOHO_BOOKS_AUTHORIZATION_REQUIRED",
      message:
        "Zoho authorization is unavailable. Reauthorize or verify the invoice-read permission.",
    };
  }
  if (error instanceof ZohoBooksApiError) {
    if (error.status === 404 && error.apiCode === 1002) {
      return {
        status: 404,
        code: "ZOHO_INVOICE_NOT_FOUND",
        message: "Zoho Books explicitly reported that the requested invoice does not exist.",
      };
    }
    return error.status === 401 || error.status === 403
      ? {
          status: 503,
          code: "ZOHO_BOOKS_AUTHORIZATION_REQUIRED",
          message:
            "Zoho authorization is unavailable. Reauthorize or verify the invoice-read permission.",
        }
      : error.status === 429
        ? {
            status: 503,
            code: "ZOHO_BOOKS_RATE_LIMITED",
            message: "Zoho Books is rate limiting requests. Retry later.",
          }
        : {
            status: 502,
            code: "ZOHO_BOOKS_UPSTREAM_ERROR",
            message: "Zoho Books could not complete the invoice request.",
          };
  }
  if (error instanceof ZohoBooksTransportError || error instanceof ZohoBooksResponseError) {
    return {
      status: 502,
      code:
        error instanceof ZohoBooksTransportError
          ? "ZOHO_BOOKS_TRANSPORT_ERROR"
          : "ZOHO_BOOKS_INVALID_RESPONSE",
      message: "Zoho Books could not complete the invoice request.",
    };
  }
  return null;
}

function safeFailureCode(code: string): string {
  return code === "DEVICE_REJECTED" ? code : "FISCALIZATION_FAILED";
}

/**
 * Read-only HTTP endpoints for retrieving and mapping Zoho Books invoices.
 *
 * Neither endpoint can fiscalize an invoice or send commands to the
 * Tremol device.
 */
export function createZohoBooksRouter(
  booksClient: ZohoBooksClient | undefined,
  invoiceService?: ZohoInvoiceService,
  prepareFiscalizationRequestService?: PrepareFiscalizationRequestService,
  fiscalizationRepository?: FiscalizationRepository,
  fiscalizationService?: FiscalizationService,
  prepareTremolReceiptPlan?: PrepareTremolReceiptPlan,
  invoiceImportService?: ImportZohoInvoicesService,
  zohoInvoiceSynchronizationService?: ZohoInvoiceSynchronizationService,
  etimsReportingService?: EtimsReportingService,
  orchestrationService?: FiscalizationOrchestrationService,
  manualReviewService?: ManualReviewService,
  metrics: OperationalMetrics = operationalMetrics,
  zohoWritebackService?: ZohoFiscalizationWritebackService,
): Router {
  const router = Router();
  router.use(requirePermission("invoice:read"));

  router.get(
    "/fiscalization-requests/:requestId/zoho-writeback",
    requirePermission("request:read"),
    async (req, res) => {
      if (!zohoWritebackService) {
        res.status(503).json({
          error: {
            code: "ZOHO_WRITEBACK_UNAVAILABLE",
            message: "Zoho writeback is not configured.",
          },
        });
        return;
      }
      const requestId = req.params["requestId"];
      const result = await zohoWritebackService.getStatus(
        typeof requestId === "string" ? requestId : "",
      );
      res.status(200).json(result);
    },
  );

  router.post(
    "/fiscalization-requests/:requestId/zoho-writeback",
    requirePermission("invoice:writeback"),
    async (req, res) => {
      const requestIdParam = req.params["requestId"];
      const requestId = typeof requestIdParam === "string" ? requestIdParam : "";
      if (!zohoWritebackService) {
        res.status(503).json({
          error: {
            code: "ZOHO_WRITEBACK_UNAVAILABLE",
            message: "Zoho writeback is not configured.",
          },
        });
        return;
      }
      try {
        const result = await zohoWritebackService.execute(requestId);
        const writebackMetricOutcome =
          result.status === "succeeded"
            ? "success"
            : result.status === "outcome_unknown" || result.status === "manual_review"
              ? "uncertain"
              : result.status === "failed"
                ? "failure"
                : "failure";
        safelyIncrementMetric(metrics, "zoho_writeback", writebackMetricOutcome);
        req.log.info(
          {
            requestId,
            correlationId: "correlationId" in result ? result.correlationId : undefined,
            outcome: writebackMetricOutcome,
            status: result.status,
          },
          "Zoho fiscalization writeback completed",
        );
        const statusCode =
          result.status === "not_eligible" ? 409 : result.status === "in_progress" ? 202 : 200;
        res.status(statusCode).json(result);
      } catch (error: unknown) {
        if (error instanceof ZohoFiscalizationWritebackNotFoundError) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "Fiscalization request was not found.",
            },
          });
          return;
        }
        req.log.error(
          { requestId, category: "unexpected_writeback_error" },
          "Zoho fiscalization writeback failed unexpectedly",
        );
        res.status(503).json({
          error: {
            code: "ZOHO_WRITEBACK_UNAVAILABLE",
            message: "Zoho writeback could not be completed.",
          },
        });
      }
    },
  );

  router.post(
    "/fiscalization-requests/:requestId/manual-review",
    requirePermission("manual-review:decide"),
    async (req, res, next) => {
      if (!manualReviewService) {
        res.status(503).json({
          error: {
            code: "MANUAL_REVIEW_UNAVAILABLE",
            message: "Manual review persistence is not configured.",
          },
        });
        return;
      }
      const body = z
        .object({ stage: z.enum(["device", "etims"]), reason: z.string().trim().min(1).max(500) })
        .strict()
        .safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          error: {
            code: "INVALID_MANUAL_REVIEW",
            message: "A valid stage and review reason are required.",
          },
        });
        return;
      }
      try {
        const identity = getApiIdentity(res);
        if (!identity) {
          res
            .status(401)
            .json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
          return;
        }
        const requestId =
          typeof req.params["requestId"] === "string" ? req.params["requestId"] : "";
        const reviewCase = await manualReviewService.open({
          requestId,
          ...body.data,
          operatorSubject: identity.subject,
        });
        if (!reviewCase) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "Fiscalization request was not found.",
            },
          });
          return;
        }
        safelyIncrementMetric(metrics, "manual_review_actions", "opened");
        req.log.info(
          {
            requestId: reviewCase.fiscalizationRequestId,
            caseId: reviewCase.id,
            operatorSubject: identity.subject,
            action: "opened",
          },
          "Operator reconciliation case opened",
        );
        res.status(201).json({ reviewCase });
      } catch (error: unknown) {
        if (error instanceof ManualReviewConflictError) {
          res
            .status(409)
            .json({ error: { code: "MANUAL_REVIEW_CONFLICT", message: error.message } });
          return;
        }
        next(error);
      }
    },
  );

  router.get("/manual-review", requirePermission("manual-review:decide"), async (req, res) => {
    if (!manualReviewService) {
      res.status(503).json({
        error: {
          code: "MANUAL_REVIEW_UNAVAILABLE",
          message: "Manual review persistence is not configured.",
        },
      });
      return;
    }
    const limitValue = Number(req.query["limit"] ?? 50);
    const offsetValue = Number(req.query["offset"] ?? 0);
    if (
      !Number.isSafeInteger(limitValue) ||
      limitValue < 1 ||
      limitValue > 100 ||
      !Number.isSafeInteger(offsetValue) ||
      offsetValue < 0
    ) {
      res.status(400).json({
        error: {
          code: "INVALID_PAGINATION",
          message: "Limit must be 1-100 and offset a non-negative integer.",
        },
      });
      return;
    }
    res.status(200).json({
      cases: await manualReviewService.listUnresolved(limitValue, offsetValue),
      limit: limitValue,
      offset: offsetValue,
    });
  });

  router.get(
    "/fiscalization-requests/:requestId/manual-review",
    requirePermission("manual-review:decide"),
    async (req, res) => {
      if (!manualReviewService) {
        res.status(503).json({
          error: {
            code: "MANUAL_REVIEW_UNAVAILABLE",
            message: "Manual review persistence is not configured.",
          },
        });
        return;
      }
      const requestId = typeof req.params["requestId"] === "string" ? req.params["requestId"] : "";
      const reviewCase = await manualReviewService.getByRequestId(requestId);
      res.status(200).json({ reviewCase });
    },
  );

  router.get(
    "/manual-review/:caseId",
    requirePermission("manual-review:decide"),
    async (req, res, next) => {
      if (!manualReviewService) {
        res.status(503).json({
          error: {
            code: "MANUAL_REVIEW_UNAVAILABLE",
            message: "Manual review persistence is not configured.",
          },
        });
        return;
      }
      try {
        const caseId = typeof req.params["caseId"] === "string" ? req.params["caseId"] : "";
        const reviewCase = await manualReviewService.get(caseId);
        if (!reviewCase) {
          res.status(404).json({
            error: {
              code: "MANUAL_REVIEW_NOT_FOUND",
              message: "Manual review case was not found.",
            },
          });
          return;
        }
        res.status(200).json({ reviewCase });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post(
    "/manual-review/:caseId/decisions",
    requirePermission("manual-review:decide"),
    async (req, res, next) => {
      if (!manualReviewService) {
        res.status(503).json({
          error: {
            code: "MANUAL_REVIEW_UNAVAILABLE",
            message: "Manual review persistence is not configured.",
          },
        });
        return;
      }
      const body = z
        .object({
          requestedOutcome: z.enum([
            "confirmed_success",
            "confirmed_failure",
            "still_unknown",
            "escalated",
            "investigation_note",
          ]),
          reason: z.string().trim().min(1).max(500),
          evidenceReference: z.string().trim().min(1).max(500).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          error: {
            code: "INVALID_REVIEW_DECISION",
            message: "A valid decision, reason, and optional evidence reference are required.",
          },
        });
        return;
      }
      try {
        const identity = getApiIdentity(res);
        if (!identity) {
          res
            .status(401)
            .json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
          return;
        }
        const caseId = typeof req.params["caseId"] === "string" ? req.params["caseId"] : "";
        const reviewCase = await manualReviewService.decide({
          caseId,
          operatorSubject: identity.subject,
          requestedOutcome: body.data.requestedOutcome,
          reason: body.data.reason,
          ...(body.data.evidenceReference
            ? { evidenceReference: body.data.evidenceReference }
            : {}),
        });
        if (!reviewCase) {
          res.status(404).json({
            error: {
              code: "MANUAL_REVIEW_NOT_FOUND",
              message: "Manual review case was not found.",
            },
          });
          return;
        }
        const resolutionMetricOutcome =
          body.data.requestedOutcome === "escalated"
            ? "escalated"
            : reviewCase.status === "resolved"
              ? "resolved"
              : "uncertain";
        safelyIncrementMetric(metrics, "manual_review_actions", resolutionMetricOutcome);
        req.log.info(
          {
            requestId: reviewCase.fiscalizationRequestId,
            caseId: reviewCase.id,
            operatorSubject: identity.subject,
            action: resolutionMetricOutcome,
          },
          "Operator reconciliation decision recorded",
        );
        res.status(200).json({ reviewCase });
      } catch (error: unknown) {
        if (error instanceof ManualReviewConflictError) {
          res
            .status(409)
            .json({ error: { code: "MANUAL_REVIEW_CONFLICT", message: error.message } });
          return;
        }
        next(error);
      }
    },
  );

  router.get(
    "/fiscalization-requests",
    requirePermission("request:read"),
    async (req, res, next) => {
      if (!fiscalizationRepository?.listHistory) {
        res.status(503).json({
          error: { code: "HISTORY_UNAVAILABLE", message: "Request history is not configured." },
        });
        return;
      }
      const querySchema = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
          status: z
            .enum(["Pending", "InProgress", "Succeeded", "Failed", "OutcomeUnknown"])
            .optional(),
          deviceOutcome: z
            .enum(["Pending", "InProgress", "Succeeded", "Failed", "OutcomeUnknown"])
            .optional(),
          createdFrom: z.iso.datetime({ offset: true }).optional(),
          createdTo: z.iso.datetime({ offset: true }).optional(),
          etimsStatus: z
            .enum([
              "not_configured",
              "blocked",
              "pending",
              "in_progress",
              "accepted",
              "rejected",
              "outcome_unknown",
              "reconciliation_required",
              "reconciling",
            ])
            .optional(),
          correlationId: z.string().trim().min(1).max(100).optional(),
        })
        .strict();
      const parsed = querySchema.safeParse(req.query);
      if (
        !parsed.success ||
        (parsed.data.status &&
          parsed.data.deviceOutcome &&
          parsed.data.status !== parsed.data.deviceOutcome) ||
        (parsed.data.createdFrom &&
          parsed.data.createdTo &&
          Date.parse(parsed.data.createdFrom) > Date.parse(parsed.data.createdTo))
      ) {
        res.status(400).json({
          error: {
            code: "INVALID_HISTORY_QUERY",
            message: "History filters or pagination values are invalid.",
          },
        });
        return;
      }
      // Prisma/provider offsets are bounded signed 32-bit integers. Refuse
      // unbounded page numbers instead of allowing a huge OFFSET to become a
      // database error or an expensive query.
      if ((parsed.data.page - 1) * parsed.data.pageSize > 2_147_483_647) {
        res.status(400).json({
          error: {
            code: "INVALID_HISTORY_QUERY",
            message: "The requested history page is beyond the supported range.",
          },
        });
        return;
      }
      try {
        const result = await fiscalizationRepository.listHistory({
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          ...(parsed.data.status ? { status: parsed.data.status } : {}),
          ...(parsed.data.deviceOutcome ? { deviceOutcome: parsed.data.deviceOutcome } : {}),
          ...(parsed.data.createdFrom ? { createdFrom: new Date(parsed.data.createdFrom) } : {}),
          ...(parsed.data.createdTo ? { createdTo: new Date(parsed.data.createdTo) } : {}),
          ...(parsed.data.etimsStatus ? { etimsStatus: parsed.data.etimsStatus } : {}),
          ...(parsed.data.correlationId ? { correlationId: parsed.data.correlationId } : {}),
        });
        const items = result.summaries
          ? result.summaries.map((summary) => ({
              id: summary.id,
              zohoInvoiceId: summary.zohoInvoiceId,
              status: summary.status,
              deviceOutcome: summary.status,
              etimsOutcome: summary.etimsStatus ?? "not_configured",
              correlationId: summary.correlationId,
              createdAt: summary.createdAt.toISOString(),
              updatedAt: summary.updatedAt.toISOString(),
              failureCode: summary.failureCode,
              deviceAttempts: summary.deviceAttempts,
            }))
          : await Promise.all(
              result.records.map(async (record) => {
                const etims = await etimsReportingService?.getByFiscalizationRequestId(record.id);
                const attempts =
                  (await fiscalizationRepository.findAttemptsByRequestId?.(record.id)) ?? [];
                return {
                  id: record.id,
                  zohoInvoiceId: record.zohoInvoiceId,
                  status: record.status,
                  deviceOutcome: record.status,
                  etimsOutcome: etims?.operation.status ?? "not_configured",
                  correlationId: etims?.operation.correlationId ?? null,
                  createdAt: record.createdAt.toISOString(),
                  updatedAt: record.updatedAt.toISOString(),
                  failureCode: record.failure?.code ?? null,
                  deviceAttempts: attempts.map((attempt) => ({
                    attemptNumber: attempt.attemptNumber,
                    outcome: attempt.outcome,
                    errorCode: attempt.errorCode,
                  })),
                };
              }),
            );
        res.status(200).json({
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
          total: result.total,
          items,
        });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  router.post("/invoices/import", requirePermission("admin:configure"), async (_req, res) => {
    if (zohoInvoiceSynchronizationService) {
      const result = await zohoInvoiceSynchronizationService.execute();
      const statusCode =
        result.state === "succeeded"
          ? 200
          : result.state === "busy"
            ? 409
            : result.state === "partial"
              ? 207
              : 502;
      res.status(statusCode).json({ synchronization: result });
      return;
    }

    if (!invoiceImportService) {
      res.status(503).json({
        error: {
          code: "ZOHO_INVOICE_IMPORT_UNAVAILABLE",
          message: "Zoho invoice importing is not configured.",
        },
      });
      return;
    }

    const result = await invoiceImportService.execute();
    const statusCode = result.state === "completed" ? 200 : result.state === "partial" ? 207 : 502;
    res.status(statusCode).json({ import: result });
  });

  router.get("/invoices/sync/status", async (_req, res, next) => {
    if (!zohoInvoiceSynchronizationService) {
      res.status(503).json({
        error: {
          code: "ZOHO_SYNCHRONIZATION_UNAVAILABLE",
          message: "Zoho invoice synchronization is not configured.",
        },
      });
      return;
    }

    try {
      res
        .status(200)
        .json({ synchronization: await zohoInvoiceSynchronizationService.getStatus() });
    } catch (error: unknown) {
      next(error);
    }
  });

  router.get("/invoices/:invoiceId/fiscal-candidate", async (req, res, next) => {
    if (!invoiceService) {
      res.status(503).json({
        error: {
          code: "ZOHO_INVOICE_SERVICE_UNAVAILABLE",
          message: "Zoho invoice mapping is not configured.",
        },
      });
      return;
    }

    const invoiceId =
      typeof req.params["invoiceId"] === "string" ? req.params["invoiceId"].trim() : "";

    if (!isValidZohoIdentifier(invoiceId)) {
      res.status(400).json({
        error: {
          code: "INVALID_INVOICE_ID",
          message: "A valid invoice ID is required.",
        },
      });
      return;
    }

    try {
      const result = await invoiceService.getFiscalInvoiceCandidate(invoiceId);

      if (!result.success) {
        req.log.warn({ errorCount: result.errors.length }, "Zoho invoice could not be mapped");

        res.status(422).json({
          error: {
            code: "ZOHO_INVOICE_MAPPING_FAILED",
            message:
              "The retrieved Zoho invoice could not be mapped to the internal invoice format.",
          },
          details: result.errors,
        });
        return;
      }

      res.status(200).json({
        candidate: result.candidate,
      });
    } catch (error: unknown) {
      const failure = zohoInvoiceRequestFailure(error);
      if (failure) {
        req.log.warn(
          {
            ...(error instanceof ZohoBooksApiError ? { upstreamStatus: error.status } : {}),
            code: failure.code,
          },
          "Zoho Books invoice request failed",
        );
        res
          .status(failure.status)
          .json({ error: { code: failure.code, message: failure.message } });
        return;
      }

      next(error);
    }
  });

  router.get("/invoices/:invoiceId", async (req, res, next) => {
    if (!booksClient) {
      res.status(503).json({
        error: {
          code: "ZOHO_BOOKS_UNAVAILABLE",
          message: "Zoho Books invoice retrieval is not configured.",
        },
      });
      return;
    }

    const invoiceId =
      typeof req.params["invoiceId"] === "string" ? req.params["invoiceId"].trim() : "";

    if (!isValidZohoIdentifier(invoiceId)) {
      res.status(400).json({
        error: {
          code: "INVALID_INVOICE_ID",
          message: "A valid invoice ID is required.",
        },
      });
      return;
    }

    try {
      const invoice = await booksClient.getInvoice(invoiceId);
      res.status(200).json({ invoice });
    } catch (error: unknown) {
      const failure = zohoInvoiceRequestFailure(error);
      if (failure) {
        req.log.warn(
          {
            ...(error instanceof ZohoBooksApiError ? { upstreamStatus: error.status } : {}),
            code: failure.code,
          },
          "Zoho Books invoice request failed",
        );
        res
          .status(failure.status)
          .json({ error: { code: failure.code, message: failure.message } });
        return;
      }

      next(error);
    }
  });

  router.post(
    "/invoices/:invoiceId/fiscalization-requests",
    requirePermission("request:create"),
    async (req, res, next) => {
      if (!prepareFiscalizationRequestService) {
        res.status(503).json({
          error: {
            code: "FISCALIZATION_REQUEST_SERVICE_UNAVAILABLE",
            message: "Fiscalization request preparation is not configured.",
          },
        });
        return;
      }

      const invoiceId =
        typeof req.params["invoiceId"] === "string" ? req.params["invoiceId"].trim() : "";

      if (!isValidZohoIdentifier(invoiceId)) {
        res.status(400).json({
          error: {
            code: "INVALID_INVOICE_ID",
            message: "A valid invoice ID is required.",
          },
        });
        return;
      }

      if (
        req.body !== undefined &&
        (typeof req.body !== "object" ||
          req.body === null ||
          Array.isArray(req.body) ||
          Object.keys(req.body).length > 0)
      ) {
        res.status(400).json({
          error: {
            code: "INVALID_INVOICE_SYNCHRONIZATION_INPUT",
            message:
              "Invoice synchronization accepts the invoice ID in the path and no request body.",
          },
        });
        return;
      }

      try {
        const result = orchestrationService
          ? await orchestrationService.synchronizeInvoice(invoiceId)
          : await prepareFiscalizationRequestService.synchronize(invoiceId);
        safelyIncrementMetric(
          metrics,
          "requests_processed",
          result.kind === "registered" ? "success" : "failure",
        );

        if (result.kind === "mapping-failed") {
          req.log.warn(
            { errorCount: result.errors.length },
            "Zoho invoice could not be mapped for fiscalization request",
          );

          res.status(422).json({
            error: {
              code: "ZOHO_INVOICE_MAPPING_FAILED",
              message: "The Zoho invoice could not be mapped to the internal invoice format.",
            },
            state: "validation_failed",
            details: result.errors,
          });
          return;
        }

        if (result.kind === "snapshot-failed") {
          req.log.warn(
            { errorCount: result.errors.length },
            "Fiscalization inputs could not be snapshotted",
          );
          res.status(422).json({
            error: {
              code: "FISCALIZATION_INPUTS_INVALID",
              message: "The invoice or its fiscal profile inputs failed validation.",
            },
            state: "validation_failed",
            details: result.errors,
          });
          return;
        }

        res.status(result.alreadyExisted ? 200 : 201).json({
          request: {
            id: result.record.id,
            zohoInvoiceId: result.record.zohoInvoiceId,
            status: result.record.status,
            snapshotId: result.record.snapshot?.snapshotId ?? null,
            createdAt: result.record.createdAt,
            updatedAt: result.record.updatedAt,
          },
          alreadyExisted: result.alreadyExisted,
        });
      } catch (error: unknown) {
        if (error instanceof DuplicateZohoInvoiceError) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_REQUEST_CONFLICT",
              message: "The request was created concurrently but could not be retrieved safely.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationRequestPersistenceError) {
          safelyIncrementMetric(metrics, "database_failures", "failure");
          req.log.error({ invoiceId }, "Fiscalization request persistence failed");
          res.status(503).json({
            error: {
              code: "FISCALIZATION_REQUEST_PERSISTENCE_FAILED",
              message:
                "The invoice was retrieved but its fiscalization request could not be stored.",
            },
          });
          return;
        }

        if (error instanceof ZohoBooksApiError || error instanceof ZohoBooksAuthorizationError) {
          const authorizationFailure =
            error instanceof ZohoBooksAuthorizationError ||
            error.status === 401 ||
            error.status === 403;
          req.log.warn(
            {
              ...(error instanceof ZohoBooksApiError ? { upstreamStatus: error.status } : {}),
              category: authorizationFailure
                ? "authorization_failure"
                : error instanceof ZohoBooksApiError &&
                    error.status === 404 &&
                    error.apiCode === 1002
                  ? "invoice_not_found"
                  : "upstream_api_error",
            },
            "Zoho Books invoice request failed during fiscalization preparation",
          );

          const notFound =
            error instanceof ZohoBooksApiError && error.status === 404 && error.apiCode === 1002;
          const rateLimited = error instanceof ZohoBooksApiError && error.status === 429;
          res.status(notFound ? 404 : authorizationFailure || rateLimited ? 503 : 502).json({
            error: {
              code: notFound
                ? "ZOHO_INVOICE_NOT_FOUND"
                : authorizationFailure
                  ? "ZOHO_BOOKS_AUTHORIZATION_REQUIRED"
                  : rateLimited
                    ? "ZOHO_BOOKS_RATE_LIMITED"
                    : "ZOHO_BOOKS_UPSTREAM_ERROR",
              message: notFound
                ? "Zoho Books explicitly reported that the requested invoice does not exist."
                : authorizationFailure
                  ? "Zoho authorization is unavailable. Reauthorize or verify the invoice-read permission."
                  : rateLimited
                    ? "Zoho Books is rate limiting requests. Retry later."
                    : "Zoho Books could not complete the invoice request.",
            },
          });
          return;
        }

        if (error instanceof ZohoBooksTransportError || error instanceof ZohoBooksResponseError) {
          req.log.warn(
            {
              category:
                error instanceof ZohoBooksTransportError ? "transport_failure" : "invalid_response",
            },
            "Zoho Books invoice synchronization did not complete",
          );
          res.status(502).json({
            error: {
              code:
                error instanceof ZohoBooksTransportError
                  ? "ZOHO_BOOKS_TRANSPORT_ERROR"
                  : "ZOHO_BOOKS_INVALID_RESPONSE",
              message: "Zoho Books could not complete the invoice request.",
            },
          });
          return;
        }

        next(error);
      }
    },
  );

  /**
   * Processes a registered fiscalization request.
   *
   * This endpoint remains blocked until issuance prerequisites and a
   * verified FiscalDevice implementation are explicitly satisfied.
   *
   * A request is never automatically retried after an uncertain
   * device outcome.
   */
  router.post(
    "/fiscalization-requests/:requestId/process",
    requirePermission("device:operate"),
    async (req, res, next) => {
      if (!fiscalizationService) {
        res.status(503).json({
          error: {
            code: "FISCALIZATION_PROCESSING_UNAVAILABLE",
            message: "Fiscalization processing is not configured with a verified fiscal device.",
          },
        });
        return;
      }

      const requestId =
        typeof req.params["requestId"] === "string" ? req.params["requestId"].trim() : "";

      if (!requestId) {
        res.status(400).json({
          error: {
            code: "INVALID_FISCALIZATION_REQUEST_ID",
            message: "A valid fiscalization request ID is required.",
          },
        });
        return;
      }

      try {
        const result = orchestrationService
          ? await orchestrationService.processDeviceStage(requestId)
          : await fiscalizationService.fiscalize({ id: requestId });
        safelyIncrementMetric(
          metrics,
          "device_attempts",
          result.status === "Succeeded"
            ? "success"
            : result.status === "OutcomeUnknown"
              ? "uncertain"
              : result.status === "Failed"
                ? "failure"
                : "failure",
        );

        res.status(200).json({
          request: {
            id: result.id,
            zohoInvoiceId: result.zohoInvoiceId,
            status: result.status,
            createdAt: result.createdAt,
            updatedAt: result.updatedAt,
          },
        });
      } catch (error: unknown) {
        if (error instanceof FiscalizationRequestNotFoundError) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "The fiscalization request was not found.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationIssuanceDisabledError) {
          res.status(503).json({
            error: {
              code: "FISCALIZATION_ISSUANCE_DISABLED",
              message:
                "Receipt issuance is disabled until payment, tax, and device contracts are verified.",
            },
            blockedBy: error.blockers,
          });
          return;
        }
        if (error instanceof FiscalDeviceNotReadyError) {
          res.status(503).json({
            error: {
              code: "FISCAL_DEVICE_NOT_READY",
              message: "The fiscal device is not ready. The request remains pending.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationSnapshotMissingError) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_SNAPSHOT_REQUIRED",
              message: "This legacy request requires operator review before processing.",
            },
          });
          return;
        }

        if (error instanceof UnsupportedFiscalizationSnapshotVersionError) {
          res.status(422).json({
            error: {
              code: "UNSUPPORTED_FISCALIZATION_SNAPSHOT_VERSION",
              message: "This request uses an unsupported fiscalization snapshot version.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationSnapshotError) {
          res.status(422).json({
            error: {
              code: "INVALID_FISCALIZATION_SNAPSHOT",
              message: "The stored fiscalization snapshot could not be validated.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationClaimError) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_CLAIMABLE",
              message:
                "The request could not be claimed. Check its current status before taking further action.",
            },
          });
          return;
        }

        if (error instanceof FiscalizationPersistenceError) {
          safelyIncrementMetric(metrics, "database_failures", "failure");
          req.log.error(
            { requestId },
            "Fiscalization outcome could not be persisted; reconciliation is required",
          );

          res.status(503).json({
            error: {
              code: "FISCALIZATION_OUTCOME_REQUIRES_RECONCILIATION",
              message:
                "The device outcome could not be reliably saved. Reconcile the request before any further action.",
            },
          });
          return;
        }

        next(error);
      }
    },
  );

  router.post(
    "/fiscalization-requests/:requestId/etims/reconcile",
    requirePermission("etims:reconcile"),
    async (req, res, next) => {
      if (!etimsReportingService || !orchestrationService) {
        res.status(503).json({
          error: {
            code: "ETIMS_RECONCILIATION_UNAVAILABLE",
            message: "eTIMS reconciliation is not configured.",
          },
        });
        return;
      }

      const requestId =
        typeof req.params["requestId"] === "string" ? req.params["requestId"].trim() : "";
      if (!requestId) {
        res.status(400).json({
          error: {
            code: "INVALID_FISCALIZATION_REQUEST_ID",
            message: "A valid fiscalization request ID is required.",
          },
        });
        return;
      }

      if (
        typeof req.body !== "object" ||
        req.body === null ||
        Array.isArray(req.body) ||
        !Object.prototype.hasOwnProperty.call(req.body, "payload")
      ) {
        res.status(400).json({
          error: {
            code: "ETIMS_RECONCILIATION_PAYLOAD_REQUIRED",
            message: "The immutable eTIMS payload is required to reconcile this operation.",
          },
        });
        return;
      }

      try {
        const current = await orchestrationService.getStatus(requestId);
        if (!current) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "The fiscalization request was not found.",
            },
          });
          return;
        }
        if (!current.etims) {
          res.status(409).json({
            error: {
              code: "ETIMS_OPERATION_NOT_FOUND",
              message: "No eTIMS operation is registered for this request.",
            },
          });
          return;
        }
        const result = await orchestrationService.reconcileEtimsStage(requestId, req.body.payload);
        const reconciliationOutcome =
          result.operation.status === "outcome_unknown" ||
          result.operation.status === "reconciliation_required"
            ? "uncertain"
            : result.operation.status === "accepted" || result.operation.status === "rejected"
              ? "reconciled"
              : "failure";
        safelyIncrementMetric(metrics, "reconciliations", reconciliationOutcome);
        safelyIncrementMetric(
          metrics,
          "etims_attempts",
          result.operation.status === "accepted"
            ? "success"
            : result.operation.status === "outcome_unknown"
              ? "uncertain"
              : result.operation.status === "rejected"
                ? "failure"
                : "failure",
        );
        res.status(200).json({
          operation: {
            id: result.operation.id,
            correlationId: result.operation.correlationId,
            status: result.operation.status,
            attemptNumber: result.operation.attemptNumber,
            reconciliationAttemptNumber: result.operation.reconciliationAttemptNumber,
            reconciliationRequired: result.operation.reconciliationRequired,
          },
          attempts: result.attempts.map((attempt) => ({
            id: attempt.id,
            type: attempt.attemptType,
            number: attempt.attemptNumber,
            startedAt: attempt.startedAt,
            completedAt: attempt.completedAt,
            outcome: attempt.outcome,
            providerReference: attempt.providerReference,
            errorCategory: attempt.errorCategory,
            errorMessage: attempt.errorMessage,
          })),
        });
      } catch (error: unknown) {
        if (error instanceof Error && error.message.includes("immutable payload hash")) {
          res.status(422).json({
            error: {
              code: "ETIMS_RECONCILIATION_PAYLOAD_MISMATCH",
              message: "The supplied eTIMS payload does not match the registered operation.",
            },
          });
          return;
        }
        next(error);
      }
    },
  );

  router.post(
    "/fiscalization-requests/:requestId/execute",
    requirePermission("device:operate"),
    async (req, res, next) => {
      if (!orchestrationService) {
        res.status(503).json({
          error: {
            code: "FISCALIZATION_WORKFLOW_UNAVAILABLE",
            message: "Fiscalization workflow is not configured.",
          },
        });
        return;
      }
      const body = z
        .object({
          configuration: z.unknown().refine((value) => value !== undefined),
          context: z.unknown().refine((value) => value !== undefined),
          calculationEvidence: z.unknown().refine((value) => value !== undefined),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) {
        res.status(400).json({
          error: {
            code: "INVALID_FISCALIZATION_WORKFLOW_INPUT",
            message: "Mapping configuration, context, and calculation evidence are required.",
          },
        });
        return;
      }
      const requestId =
        typeof req.params["requestId"] === "string" ? req.params["requestId"].trim() : "";
      if (!requestId) {
        res.status(400).json({
          error: {
            code: "INVALID_FISCALIZATION_REQUEST_ID",
            message: "A valid request ID is required.",
          },
        });
        return;
      }
      try {
        const result = await orchestrationService.executeMapped({
          requestId,
          ...body.data,
          onStageStart: (stage, simulated) =>
            req.log.info({ requestId, stage, simulated }, "Fiscalization workflow stage started"),
        });
        if (result.state === "mapping_failed") {
          req.log.warn(
            { requestId, mappingErrorCount: result.mapping?.errors.length ?? 0 },
            "Fiscalization workflow mapping preflight failed",
          );
          res.status(422).json({
            error: {
              code: "FISCALIZATION_MAPPING_FAILED",
              message: "The invoice could not be mapped safely.",
            },
            state: result.state,
            details: result.mapping?.errors ?? [],
          });
          return;
        }
        req.log.info(
          {
            requestId,
            state: result.state,
            simulated: result.simulated,
            blockers: result.blockers,
            stages: result.stages.map(({ stage, result: stageResult }) => ({
              stage,
              status: "status" in stageResult ? stageResult.status : stageResult.operation.status,
            })),
          },
          "Fiscalization workflow execution finished",
        );
        if (result.state === "blocked" && result.stages.length === 0) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_WORKFLOW_BLOCKED",
              message:
                "No workflow stage was run because sequence approval or a preflight check is blocked.",
            },
            blockers: result.blockers,
          });
          return;
        }
        const status = await orchestrationService.getStatus(requestId);
        if (!status) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "The request was not found.",
            },
          });
          return;
        }
        res.status(result.state === "completed" ? 200 : 202).json({
          state: result.state,
          simulated: result.simulated,
          blockers: result.blockers,
          stages: result.stages.map(({ stage, result: stageResult }) => ({
            stage,
            status: "status" in stageResult ? stageResult.status : stageResult.operation.status,
          })),
          request: {
            id: status.fiscalization.id,
            status: status.fiscalization.status,
            outcomeUnknownReason: status.fiscalization.outcomeUnknownReason,
          },
          etims: status.etims
            ? {
                status: status.etims.operation.status,
                attemptNumber: status.etims.operation.attemptNumber,
                reconciliationRequired: status.etims.operation.reconciliationRequired,
                simulated: result.simulated,
              }
            : null,
        });
      } catch (error: unknown) {
        if (error instanceof FiscalizationMappingConfigurationConflictError) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_MAPPING_CONFIGURATION_CONFLICT",
              message: "The request already has a different mapping configuration archived.",
            },
          });
          return;
        }
        if (error instanceof Error && error.name === "FiscalizationWorkflowRequestNotFoundError") {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "The request was not found.",
            },
          });
          return;
        }
        if (error instanceof FiscalizationClaimError) {
          res.status(409).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_CLAIMABLE",
              message:
                "Another worker claimed this request or its current state prevents execution.",
            },
          });
          return;
        }
        if (error instanceof FiscalizationIssuanceDisabledError) {
          res.status(503).json({
            error: {
              code: "FISCALIZATION_EXECUTION_DISABLED",
              message: "The device stage is disabled by the configured safety gates.",
            },
            blockers: error.blockers,
          });
          return;
        }
        if (error instanceof FiscalDeviceNotReadyError) {
          res.status(503).json({
            error: {
              code: "FISCAL_DEVICE_NOT_READY",
              message: "The device stage is unavailable; no receipt operation was claimed.",
            },
          });
          return;
        }
        if (error instanceof FiscalizationPersistenceError) {
          safelyIncrementMetric(metrics, "database_failures", "failure");
          res.status(503).json({
            error: {
              code: "FISCALIZATION_OUTCOME_REQUIRES_RECONCILIATION",
              message:
                "A stage outcome could not be persisted; reconcile the request before retrying.",
            },
          });
          return;
        }
        next(error);
      }
    },
  );

  /**
   * Builds a read-only, non-executable Tremol receipt plan for a Zoho invoice.
   *
   * This endpoint never sends commands to the fiscal device.
   */
  router.get("/invoices/:invoiceId/tremol-receipt-plan", async (req, res, next) => {
    if (!prepareTremolReceiptPlan || !invoiceService) {
      res.status(503).json({
        error: {
          code: "TREMOL_RECEIPT_PLAN_UNAVAILABLE",
          message: "Receipt-plan preparation is not configured.",
        },
      });
      return;
    }

    const invoiceId =
      typeof req.params["invoiceId"] === "string" ? req.params["invoiceId"].trim() : "";

    if (!isValidZohoIdentifier(invoiceId)) {
      res.status(400).json({
        error: {
          code: "INVALID_INVOICE_ID",
          message: "A valid invoice ID is required.",
        },
      });
      return;
    }

    try {
      const mapping = await invoiceService.getFiscalInvoiceCandidate(invoiceId);

      if (!mapping.success) {
        req.log.warn(
          { errorCount: mapping.errors.length },
          "Zoho invoice could not be mapped for Tremol receipt-plan preparation",
        );

        res.status(422).json({
          error: {
            code: "ZOHO_INVOICE_MAPPING_FAILED",
            message: "The Zoho invoice could not be mapped to the internal invoice format.",
          },
          details: mapping.errors,
        });
        return;
      }

      const result = await prepareTremolReceiptPlan.execute(mapping.candidate);

      if (!result.success) {
        res.status(422).json({
          error: {
            code: "TREMOL_RECEIPT_PLAN_VALIDATION_FAILED",
            message: "The invoice or its fiscal metadata failed validation.",
          },
          details: result.errors,
        });
        return;
      }

      res.status(200).json({
        plan: result.plan,
      });
    } catch (error: unknown) {
      if (error instanceof ZohoBooksApiError) {
        req.log.warn(
          { upstreamStatus: error.status },
          "Zoho Books request failed during receipt-plan preparation",
        );

        res.status(502).json({
          error: {
            code: "ZOHO_BOOKS_UPSTREAM_ERROR",
            message: "Zoho Books could not complete the invoice request.",
          },
        });
        return;
      }

      next(error);
    }
  });

  /**
   * Returns the current state of a registered fiscalization request.
   *
   * This endpoint is read-only. It never claims or processes a request
   * and never sends commands to the fiscal device.
   */
  router.get(
    "/fiscalization-requests/:requestId",
    requirePermission("request:read"),
    async (req, res, next) => {
      if (!fiscalizationRepository) {
        res.status(503).json({
          error: {
            code: "FISCALIZATION_REPOSITORY_UNAVAILABLE",
            message: "Fiscalization request lookup is not configured.",
          },
        });
        return;
      }

      const requestId =
        typeof req.params["requestId"] === "string" ? req.params["requestId"].trim() : "";

      if (!requestId) {
        res.status(400).json({
          error: {
            code: "INVALID_FISCALIZATION_REQUEST_ID",
            message: "A valid fiscalization request ID is required.",
          },
        });
        return;
      }

      try {
        const workflowStatus = await orchestrationService?.getStatus(requestId);
        const record =
          workflowStatus?.fiscalization ?? (await fiscalizationRepository.findById(requestId));

        if (!record) {
          res.status(404).json({
            error: {
              code: "FISCALIZATION_REQUEST_NOT_FOUND",
              message: "The fiscalization request was not found.",
            },
          });
          return;
        }

        const snapshotValid = isValidStoredSnapshot(record.snapshot, record.snapshotVersion);
        const snapshotPresent = record.snapshot !== null && record.snapshot !== undefined;
        const [etimsReadiness, etimsOperation] = await Promise.all([
          Promise.resolve(etimsReportingService?.getReadiness()),
          workflowStatus?.etims ??
            etimsReportingService?.getByFiscalizationRequestId(requestId) ??
            Promise.resolve(null),
        ]);
        const etimsNeedsReview = Boolean(
          etimsOperation &&
          (etimsOperation.operation.reconciliationRequired ||
            ["in_progress", "outcome_unknown", "reconciliation_required", "reconciling"].includes(
              etimsOperation.operation.status,
            )),
        );
        const reconciliationRequired = record.status === "OutcomeUnknown" || etimsNeedsReview;
        const operatorReviewRequired =
          reconciliationRequired ||
          record.status === "InProgress" ||
          (!snapshotValid && record.status !== "Succeeded" && record.status !== "Failed");
        const issuanceBlockers = fiscalizationService?.getIssuanceBlockers() ?? [
          "issuance_disabled",
          "payment_source_unverified",
          "tax_rules_unverified",
          "device_contract_unverified",
          "device_adapter_unavailable",
        ];

        res.status(200).json({
          request: {
            id: record.id,
            zohoInvoiceId: record.zohoInvoiceId,
            status: record.status,
            processingOutcome: {
              state: reconciliationRequired
                ? "unknown_requires_reconciliation"
                : record.status === "Pending"
                  ? "pending"
                  : record.status === "InProgress"
                    ? "processing"
                    : record.status === "Succeeded"
                      ? fiscalizationService?.getIssuanceMode() === "simulation_only"
                        ? "simulated_success"
                        : "confirmed_fiscal_success"
                      : "device_or_integration_failure",
              reconciliationRequired,
            },
            issuance: {
              enabled: issuanceBlockers.length === 0,
              blockedBy: issuanceBlockers,
            },
            integrations: {
              etims:
                etimsOperation?.operation.status ??
                etimsReadiness?.status ??
                ETIMS_REPORTING_STATUS,
              etimsSimulated: etimsReadiness?.simulated ?? false,
              etimsBlockedBy:
                etimsOperation?.operation.status === "blocked"
                  ? [etimsOperation.operation.errorCategory ?? "reporting_blocked"]
                  : (etimsReadiness?.blockers ?? ETIMS_REPORTING_BLOCKERS),
              etimsReporting: etimsOperation
                ? {
                    operationId: etimsOperation.operation.id,
                    adapterType: etimsOperation.operation.adapterType,
                    status: etimsOperation.operation.status,
                    attemptNumber: etimsOperation.operation.attemptNumber,
                    reconciliationRequired: etimsOperation.operation.reconciliationRequired,
                    attempts: etimsOperation.attempts.length,
                    attemptHistory: etimsOperation.attempts.map((attempt) => ({
                      id: attempt.id,
                      type: attempt.attemptType,
                      number: attempt.attemptNumber,
                      startedAt: attempt.startedAt,
                      completedAt: attempt.completedAt,
                      outcome: attempt.outcome,
                      providerReference: attempt.providerReference,
                      errorCategory: attempt.errorCategory,
                      errorMessage: attempt.errorMessage,
                    })),
                  }
                : null,
              zohoWriteBack: "not_configured",
            },
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            snapshot: {
              present: snapshotPresent,
              valid: snapshotValid,
              version: record.snapshotVersion,
              snapshotId: snapshotValid ? (record.snapshot?.snapshotId ?? null) : null,
            },
            receipt:
              record.status === "Succeeded" && record.receipt !== null
                ? {
                    receiptNumber: record.receipt.receiptNumber,
                    issuedAt: record.receipt.issuedAt,
                  }
                : null,
            deviceSimulated: fiscalizationService?.getIssuanceMode() === "simulation_only",
            failure:
              record.status === "Failed" && record.failure !== null
                ? {
                    code: safeFailureCode(record.failure.code),
                    message:
                      "The fiscalization operation was confirmed as failed. Review the request before taking further action.",
                  }
                : null,
            outcomeUnknown: record.status === "OutcomeUnknown",
            processingInProgress: record.status === "InProgress",
            deviceAttempts: (workflowStatus?.deviceAttempts ?? []).map((attempt) => ({
              id: attempt.id,
              attemptNumber: attempt.attemptNumber,
              startedAt: attempt.startedAt,
              completedAt: attempt.completedAt,
              outcome: attempt.outcome,
              receiptNumber: attempt.receiptNumber,
              issuedAt: attempt.issuedAt,
            })),
            reconciliationRequired,
            operatorReviewRequired,
          },
        });
      } catch (error: unknown) {
        next(error);
      }
    },
  );

  return router;
}
