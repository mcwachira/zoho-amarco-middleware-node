import { Router } from "express";
import type { ZohoInvoiceService } from "../application/zoho/zoho-invoice-service.js";
import { ZohoBooksApiError, type ZohoBooksClient } from "../integrations/zoho/books-client.js";
import type { PrepareFiscalizationRequestService } from "../application/fiscalization/prepare-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../application/fiscalization/fiscalization-errors.js";
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


  router.post(
      "/invoices/:invoiceId/fiscalization-requests",
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
            typeof req.params["invoiceId"] === "string"
                ? req.params["invoiceId"].trim()
                : "";

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
          const result =
              await prepareFiscalizationRequestService.prepare(invoiceId);

          if (result.kind === "mapping-failed") {
            req.log.warn(
                { errorCount: result.errors.length },
                "Zoho invoice could not be mapped for fiscalization request",
            );

            res.status(422).json({
              error: {
                code: "ZOHO_INVOICE_MAPPING_FAILED",
                message:
                    "The Zoho invoice could not be mapped to the internal invoice format.",
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
                message:
                    "A fiscalization request has already been registered for this Zoho invoice.",
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
      },
  );

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
        typeof req.params["requestId"] === "string"
            ? req.params["requestId"].trim()
            : "";

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
