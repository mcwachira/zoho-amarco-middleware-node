import { app } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./observability/logger.js";

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, environment: env.NODE_ENV }, "Zoho Amarco Middleware API started");
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown requested");

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "Error while closing HTTP server");
      process.exitCode = 1;
      return;
    }

    logger.info("HTTP server closed");
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
