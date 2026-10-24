import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { createFiscalizationRepositoryProvider } from "./infrastructure/database/fiscalization-repository-provider.js";
import { logger } from "./observability/logger.js";

const databaseProvider = createFiscalizationRepositoryProvider();

const app = createApp({
  checkDatabaseConnection: databaseProvider.checkConnection,
});

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      environment: env.NODE_ENV,
      databaseProvider: env.DATABASE_PROVIDER,
    },
    "Zoho Amarco Middleware API started",
  );
});

const SHUTDOWN_TIMEOUT_MS = 30_000;

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutdown requested");

  // Prevent shutdown from hanging indefinitely if HTTP connections remain open.
  const shutdownTimeout = setTimeout(() => {
    logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "Graceful shutdown timed out");

    process.exitCode = 1;
    server.closeAllConnections();

    // Do not force-exit immediately: allow the database disconnect attempt to run.
  }, SHUTDOWN_TIMEOUT_MS);

  shutdownTimeout.unref();

  server.close((serverError) => {
    if (serverError) {
      logger.error({ err: serverError }, "Error while closing HTTP server");
      process.exitCode = 1;
    } else {
      logger.info("HTTP server closed");
    }

    void databaseProvider
      .disconnect()
      .then(() => {
        logger.info("Database client disconnected");
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "Error while disconnecting database client");
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(shutdownTimeout);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
