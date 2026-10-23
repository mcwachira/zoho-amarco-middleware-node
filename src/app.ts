import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";
import * as pinoHttp from 'pino-http';
import { logger } from "./observability/logger.js";

export const app:Express = express();

app.disable("x-powered-by");

app.use(helmet());
app.use(pinoHttp.pinoHttp({ logger }));
app.use(express.json({ limit: "1mb" }));

app.get("/health/live", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health/ready", (_req, res) => {
  res.status(200).json({ status: "ready" });
});

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

  req.log.error({ err: error }, "Unhandled request error");

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred.",
    },
  });
};

app.use(errorHandler);
