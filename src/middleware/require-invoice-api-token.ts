
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/**
 * Protects invoice API endpoints using a configured bearer token.
 *
 * The token must be provided through the Authorization header:
 * Authorization: Bearer <token>
 *
 * This middleware never logs or returns the configured token.
 */
export function requireInvoiceApiToken(
    configuredToken: string | undefined,
): RequestHandler {
    return (req, res, next) => {
        if (!configuredToken) {
            res.status(503).json({
                error: {
                    code: "INVOICE_API_AUTH_UNAVAILABLE",
                    message: "Invoice API authentication is not configured.",
                },
            });
            return;
        }

        const authorization = req.get("authorization");
        const match = authorization?.match(/^Bearer ([^\s]+)$/i);
        const suppliedToken = match?.[1];

        if (!suppliedToken) {
            res.setHeader("WWW-Authenticate", "Bearer");
            res.status(401).json({
                error: {
                    code: "UNAUTHORIZED",
                    message: "A valid bearer token is required.",
                },
            });
            return;
        }

        const expected = Buffer.from(configuredToken, "utf8");
        const supplied = Buffer.from(suppliedToken, "utf8");

        // timingSafeEqual requires buffers of equal length.
        // Check lengths before comparing to avoid a RangeError.
        const valid =
            expected.length === supplied.length && timingSafeEqual(expected, supplied);

        if (!valid) {
            res.setHeader("WWW-Authenticate", "Bearer");
            res.status(401).json({
                error: {
                    code: "UNAUTHORIZED",
                    message: "A valid bearer token is required.",
                },
            });
            return;
        }

        next();
    };
}
