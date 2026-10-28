import type { RequestHandler } from "express";
import { authenticateApiToken } from "./api-authorization.js";

/** @deprecated Use api-authorization.ts for authentication and permission checks. */
export function requireInvoiceApiToken(configuredToken: string | undefined): RequestHandler {
  if (!configuredToken) {
    return (_req, res) => {
      res.status(503).json({
        error: {
          code: "INVOICE_API_AUTH_UNAVAILABLE",
          message: "Invoice API authentication is not configured.",
        },
      });
    };
  }
  return authenticateApiToken(configuredToken);
}
