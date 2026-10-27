import { Router } from "express";
import type { ZohoInvoiceService } from "../application/zoho/zoho-invoice-service.js";
import { ZohoBooksApiError, type ZohoBooksClient } from "../integrations/zoho/books-client.js";
import type { PrepareFiscalizationRequestService } from "../application/fiscalization/prepare-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../application/fiscalization/fiscalization-errors.js";
import {
  FiscalizationClaimError,
  FiscalizationPersistenceError,
  FiscalizationRequestNotFoundError,
  FiscalizationIssuanceDisabledError,
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
import {
  ETIMS_REPORTING_BLOCKERS,
  ETIMS_REPORTING_STATUS,
} from "../domain/fiscalization/etims-reporting-status.js";
import type { EtimsReportingService } from "../application/fiscalization/etims-reporting-service.js";

function isValidStoredSnapshot(snapshot: unknown, version: number | null): boolean {
  try {
    parseFiscalizationSnapshot(snapshot, version);
    return true;
  } catch {
    return false;
  }
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
): Router {
  const router = Router();

  router.post("/invoices/import", async (_req, res) => {
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

    if (!invoiceId) {
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

        res.status(502).json({
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
      if (error instanceof ZohoBooksApiError) {
        req.log.warn({ upstreamStatus: error.status }, "Zoho Books invoice request failed");

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

    if (!invoiceId) {
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
      if (error instanceof ZohoBooksApiError) {
        req.log.warn({ upstreamStatus: error.status }, "Zoho Books invoice request failed");

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

  router.post("/invoices/:invoiceId/fiscalization-requests", async (req, res, next) => {
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

    if (!invoiceId) {
      res.status(400).json({
        error: {
          code: "INVALID_INVOICE_ID",
          message: "A valid invoice ID is required.",
        },
      });
      return;
    }

    try {
      const result = await prepareFiscalizationRequestService.prepare(invoiceId);

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

      res.status(201).json({
        request: {
          id: result.record.id,
          zohoInvoiceId: result.record.zohoInvoiceId,
          status: result.record.status,
          createdAt: result.record.createdAt,
          updatedAt: result.record.updatedAt,
        },
      });
    } catch (error: unknown) {
      if (error instanceof DuplicateZohoInvoiceError) {
        res.status(409).json({
          error: {
            code: "FISCALIZATION_REQUEST_ALREADY_EXISTS",
            message: "A fiscalization request has already been registered for this Zoho invoice.",
          },
        });
        return;
      }

      if (error instanceof ZohoBooksApiError) {
        req.log.warn(
          { upstreamStatus: error.status },
          "Zoho Books invoice request failed during fiscalization preparation",
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
   * Processes a registered fiscalization request.
   *
   * This endpoint remains blocked until issuance prerequisites and a
   * verified FiscalDevice implementation are explicitly satisfied.
   *
   * A request is never automatically retried after an uncertain
   * device outcome.
   */
  router.post("/fiscalization-requests/:requestId/process", async (req, res, next) => {
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
      const result = await fiscalizationService.fiscalize({
        id: requestId,
      });

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
  });

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

    if (!invoiceId) {
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
  router.get("/fiscalization-requests/:requestId", async (req, res, next) => {
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
      const record = await fiscalizationRepository.findById(requestId);

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
        etimsReportingService?.getByFiscalizationRequestId(requestId) ?? Promise.resolve(null),
      ]);
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
            state:
              record.status === "Pending"
                ? "pending"
                : record.status === "InProgress"
                  ? "processing"
                  : record.status === "Succeeded"
                    ? "confirmed_fiscal_success"
                    : record.status === "OutcomeUnknown"
                      ? "unknown_requires_reconciliation"
                      : "device_or_integration_failure",
            reconciliationRequired: record.status === "OutcomeUnknown",
          },
          issuance: {
            enabled: issuanceBlockers.length === 0,
            blockedBy: issuanceBlockers,
          },
          integrations: {
            etims:
              etimsOperation?.operation.status ?? etimsReadiness?.status ?? ETIMS_REPORTING_STATUS,
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
          },
          receipt:
            record.status === "Succeeded" && record.receipt !== null
              ? {
                  receiptNumber: record.receipt.receiptNumber,
                  issuedAt: record.receipt.issuedAt,
                }
              : null,
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
          reconciliationRequired: record.status === "OutcomeUnknown",
          operatorReviewRequired:
            record.status === "OutcomeUnknown" ||
            record.status === "InProgress" ||
            (!snapshotValid && record.status !== "Succeeded" && record.status !== "Failed"),
        },
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
