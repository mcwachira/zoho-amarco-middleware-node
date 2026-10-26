import { Router } from "express";
import type { ZohoInvoiceService } from "../application/zoho/zoho-invoice-service.js";
import { ZohoBooksApiError, type ZohoBooksClient } from "../integrations/zoho/books-client.js";
import type { PrepareFiscalizationRequestService } from "../application/fiscalization/prepare-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../application/fiscalization/fiscalization-errors.js";
import {
  FiscalizationClaimError,
  FiscalizationInvoiceMismatchError,
  FiscalizationPersistenceError,
  FiscalizationRequestNotFoundError,
} from "../application/fiscalization/fiscalization-service.js";
import type { FiscalizationService } from "../application/fiscalization/fiscalization-service.js";
import type { FiscalizationRepository } from "../application/fiscalization/fiscalization-repository.js";

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
): Router {
  const router = Router();

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
   * This endpoint is unavailable until a verified FiscalDevice
   * implementation is explicitly wired into the application.
   *
   * A request is never automatically retried after an uncertain
   * device outcome.
   */
  router.post("/fiscalization-requests/:requestId/process", async (req, res, next) => {
    if (!fiscalizationService || !invoiceService || !fiscalizationRepository) {
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
      const existing = await fiscalizationRepository.findById(requestId);

      if (!existing) {
        res.status(404).json({
          error: {
            code: "FISCALIZATION_REQUEST_NOT_FOUND",
            message: "The fiscalization request was not found.",
          },
        });
        return;
      }

      // Always retrieve and map the invoice from Zoho before processing.
      const mapping = await invoiceService.getFiscalInvoiceCandidate(existing.zohoInvoiceId);

      if (!mapping.success) {
        req.log.warn(
          { errorCount: mapping.errors.length },
          "Zoho invoice could not be mapped for fiscalization processing",
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

      const result = await fiscalizationService.fiscalize({
        id: requestId,
        invoice: mapping.candidate,
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
      if (error instanceof ZohoBooksApiError) {
        req.log.warn(
          { upstreamStatus: error.status },
          "Zoho Books request failed during fiscalization processing",
        );

        res.status(502).json({
          error: {
            code: "ZOHO_BOOKS_UPSTREAM_ERROR",
            message: "Zoho Books could not complete the invoice request.",
          },
        });
        return;
      }

      if (error instanceof FiscalizationRequestNotFoundError) {
        res.status(404).json({
          error: {
            code: "FISCALIZATION_REQUEST_NOT_FOUND",
            message: "The fiscalization request was not found.",
          },
        });
        return;
      }

      if (error instanceof FiscalizationInvoiceMismatchError) {
        res.status(409).json({
          error: {
            code: "FISCALIZATION_INVOICE_MISMATCH",
            message: "The supplied Zoho invoice does not match the registered request.",
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

      res.status(200).json({
        request: {
          id: record.id,
          zohoInvoiceId: record.zohoInvoiceId,
          status: record.status,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    } catch (error: unknown) {
      next(error);
    }
  });

  return router;
}
