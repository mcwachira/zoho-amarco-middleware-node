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

const registrationService = new RegisterFiscalizationRequestService(
    databaseProvider.repository,
);

const prepareFiscalizationRequestService = invoiceService
    ? new PrepareFiscalizationRequestService(
        invoiceService,
        registrationService,
    )
    : undefined;

const app = createApp({
    checkDatabaseConnection: databaseProvider.checkConnection,
    fiscalizationRepository: databaseProvider.repository,
    ...(oauthService ? { oauthService } : {}),
    ...(booksClient ? { booksClient } : {}),
    ...(invoiceService ? { invoiceService } : {}),
    ...(prepareFiscalizationRequestService
        ? { prepareFiscalizationRequestService }
        : {}),
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

    void oauthAttemptCleanup
      .stop()
      .then(() => {
        logger.info("OAuth attempt cleanup stopped");

        return databaseProvider.disconnect();
      })
      .then(() => {
        logger.info("Database client disconnected");
      })
      .catch((error: unknown) => {
        logger.error(
          { err: error },
          "Error while stopping cleanup or disconnecting database client",
        );
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(shutdownTimeout);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
