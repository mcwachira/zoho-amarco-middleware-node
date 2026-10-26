import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { createFiscalizationRepositoryProvider } from "./infrastructure/database/fiscalization-repository-provider.js";
import { ZohoOAuthService } from "./application/zoho/zoho-oauth-service.js";
import { logger } from "./observability/logger.js";
import { ZohoBooksClient } from "./integrations/zoho/books-client.js";
import { ZohoInvoiceService } from "./application/zoho/zoho-invoice-service.js";
import { startZohoOAuthAttemptCleanup } from "./application/zoho/zoho-oauth-attempt-cleanup.js";
import { RegisterFiscalizationRequestService } from "./application/fiscalization/register-fiscalization-request.js";
import { PrepareFiscalizationRequestService } from "./application/fiscalization/prepare-fiscalization-request.js";
import { RecoverStaleFiscalizationsService } from "./application/fiscalization/recover-stale-fiscalizations.js";
import { startStaleFiscalizationRecoveryWorker } from "./application/fiscalization/stale-fiscalization-recovery-worker.js";

const databaseProvider = createFiscalizationRepositoryProvider();

// Enable OAuth only when all required credentials are configured.
// Otherwise, the OAuth routes will respond with HTTP 503.
const oauthService =
  env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET && env.ZOHO_OAUTH_ENCRYPTION_KEY
    ? new ZohoOAuthService({
        repository: databaseProvider.oauthAttemptRepository,
        tokenRepository: databaseProvider.zohoTokenRepository,
        clientId: env.ZOHO_CLIENT_ID,
        clientSecret: env.ZOHO_CLIENT_SECRET,
        redirectUri: env.ZOHO_REDIRECT_URI,
        accountsUrl: env.ZOHO_ACCOUNTS_URL,
        encryptionKey: env.ZOHO_OAUTH_ENCRYPTION_KEY,
      })
    : undefined;

// Enable invoice retrieval only when OAuth and the organization ID
// are configured. The client itself does not fiscalize invoices.
const booksClient =
  oauthService && env.ZOHO_ORGANIZATION_ID
    ? new ZohoBooksClient({
        tokenProvider: oauthService,
        organizationId: env.ZOHO_ORGANIZATION_ID,
      })
    : undefined;

const invoiceService = booksClient ? new ZohoInvoiceService(booksClient) : undefined;

const registrationService = new RegisterFiscalizationRequestService(databaseProvider.repository);

const prepareFiscalizationRequestService = invoiceService
  ? new PrepareFiscalizationRequestService(invoiceService, registrationService)
  : undefined;

const app = createApp({
  checkDatabaseConnection: databaseProvider.checkConnection,
  fiscalizationRepository: databaseProvider.repository,
  ...(oauthService ? { oauthService } : {}),
  ...(booksClient ? { booksClient } : {}),
  ...(invoiceService ? { invoiceService } : {}),
  ...(prepareFiscalizationRequestService ? { prepareFiscalizationRequestService } : {}),
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

// Start periodic cleanup using the existing shared database connection.
// OAuth attempts are cleaned up every 15 minutes.
const oauthAttemptCleanup = startZohoOAuthAttemptCleanup({
  repository: databaseProvider.oauthAttemptRepository,
});

// Recovery is disabled by default and starts only when explicitly enabled.
// The worker only marks stale requests OutcomeUnknown; it never retries
// fiscalization or communicates with the fiscal device.
const staleFiscalizationRecoveryWorker = env.FISCALIZATION_RECOVERY_ENABLED
  ? startStaleFiscalizationRecoveryWorker({
      service: new RecoverStaleFiscalizationsService(databaseProvider.repository),
      intervalMs: env.FISCALIZATION_RECOVERY_INTERVAL_MS,
      staleAgeMs: env.FISCALIZATION_RECOVERY_STALE_AGE_MS,
    })
  : undefined;
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

    void Promise.allSettled([
      oauthAttemptCleanup.stop(),
      staleFiscalizationRecoveryWorker?.stop() ?? Promise.resolve(),
    ])
      .then(async (results) => {
        const failures = results.filter((result) => result.status === "rejected");

        if (failures.length > 0) {
          for (const failure of failures) {
            if (failure.status === "rejected") {
              logger.error({ err: failure.reason }, "Failed to stop a background worker");
            }
          }

          // A worker may still be using the database. Do not disconnect it.
          process.exitCode = 1;
          return;
        }

        logger.info("Background workers stopped");

        await databaseProvider.disconnect();
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
