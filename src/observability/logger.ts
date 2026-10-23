import pino from "pino";

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.access_token",
      "*.refresh_token",
    ],
    censor: "[REDACTED]",
  },
});
