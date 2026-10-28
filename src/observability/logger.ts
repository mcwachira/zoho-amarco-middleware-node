import pino from "pino";
import { currentCorrelationId } from "./request-context.js";

const redaction = {
  paths: [
    // HTTP authentication and session credentials.
    "req.headers.authorization",
    "req.headers.cookie",
    "req.headers['x-api-key']",
    "res.headers['set-cookie']",

    // Common credential fields.
    "password",
    "*.password",
    "secret",
    "*.secret",
    "clientSecret",
    "*.clientSecret",
    "encryptionKey",
    "*.encryptionKey",
    "payloadEncryptionKey",
    "*.payloadEncryptionKey",
    "authorization",
    "*.code",
    "code",
    "*.state",
    "*.code_verifier",
    "*.codeVerifier",
    "*.pkce_verifier",
    "*.pkceVerifier",
    "*.client_secret",
    "*.clientSecret",
    "*.authorization_code",
    "*.authorizationCode",
    "*.access_token",
    "*.accessToken",
    "*.refresh_token",
    "*.refreshToken",
    "*.token",
    "accessToken",
    "refreshToken",
    "token",
    "*.authorization",

    // Configuration objects, if ever included in a log record.
    "ZOHO_CLIENT_SECRET",
    "ZOHO_OAUTH_ENCRYPTION_KEY",
    "INVOICE_API_BEARER_TOKEN",
    "OPERATOR_API_BEARER_TOKEN",
    "ETIMS_PAYLOAD_ENCRYPTION_KEY",
    "ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON",
    "DATABASE_URL",
    // Sensitive provider and business data must never enter routine logs.
    "invoice",
    "invoicePayload",
    "customer",
    "customerName",
    "customerEmail",
    "providerResponse",
    "responseBody",
    "*.invoice",
    "*.invoicePayload",
    "*.customer",
    "*.customerName",
    "*.customerEmail",
    "*.providerResponse",
    "*.responseBody",
  ],
  censor: "[REDACTED]",
};

export function createApplicationLogger(
  options: { level?: string; destination?: pino.DestinationStream } = {},
) {
  return pino(
    {
      level: options.level ?? process.env["LOG_LEVEL"] ?? "info",
      redact: redaction,
      mixin() {
        const correlationId = currentCorrelationId();
        return correlationId ? { correlationId } : {};
      },
    },
    options.destination,
  );
}

export const logger = createApplicationLogger();
