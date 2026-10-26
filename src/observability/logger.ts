import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: {
    paths: [
      // HTTP authentication and session credentials.
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "res.headers['set-cookie']",

      // Common credential fields.
      "*.password",
      "*.client_secret",
      "*.clientSecret",
      "*.access_token",
      "*.accessToken",
      "*.refresh_token",
      "*.refreshToken",
      "*.token",
      "*.authorization",

      // Configuration objects, if ever included in a log record.
      "ZOHO_CLIENT_SECRET",
      "ZOHO_OAUTH_ENCRYPTION_KEY",
      "INVOICE_API_BEARER_TOKEN",
      "SQLSERVER_PASSWORD",
      "DATABASE_URL",
    ],
    censor: "[REDACTED]",
  },
});
