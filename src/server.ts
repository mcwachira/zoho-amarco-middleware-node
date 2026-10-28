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
import type { PaymentsClient } from "./application/fiscalization/fiscalization-snapshot.js";
import { FiscalizationService } from "./application/fiscalization/fiscalization-service.js";
import { RecoverStaleFiscalizationsService } from "./application/fiscalization/recover-stale-fiscalizations.js";
import { startStaleFiscalizationRecoveryWorker } from "./application/fiscalization/stale-fiscalization-recovery-worker.js";
import { TremolZfpLabServerClient } from "./infrastructure/device/tremol-zfplabserver-client.js";
import { TremolDeviceDiagnostics } from "./infrastructure/device/tremol-device-diagnostics.js";
import { TremolFiscalDevice } from "./infrastructure/device/tremol-fiscal-device.js";
import { TremolHttpTransport } from "./infrastructure/device/tremol-zfplabserver-transport.js";
import { PrepareTremolReceiptPlan } from "./application/fiscalization/prepare-tremol-receipt-plan.js";
import { ImportZohoInvoicesService } from "./application/zoho/import-zoho-invoices.js";
import { ZohoInvoiceSynchronizationService } from "./application/zoho/zoho-invoice-synchronization.js";
import { startZohoInvoiceSyncWorker } from "./application/zoho/zoho-invoice-sync-worker.js";
import { ManualReviewService } from "./application/fiscalization/manual-review-service.js";
import { EtimsReportingService } from "./application/fiscalization/etims-reporting-service.js";
import { UnverifiedEtimsAdapter } from "./application/fiscalization/etims-reporting-adapter.js";
import { KraEtimsReportingAdapter } from "./integrations/etims/kra-etims-reporting-adapter.js";
import { FiscalizationOrchestrationService } from "./application/fiscalization/fiscalization-orchestration-service.js";
import {
  AesGcmEtimsPayloadProtection,
  ConfiguredEtimsPayloadKeyProvider,
  EtimsSubmissionPayloadVault,
} from "./application/fiscalization/etims-submission-payload-vault.js";
import { startConfiguredEtimsReconciliationWorker } from "./application/fiscalization/etims-reconciliation-lifecycle.js";
import { operationalMetrics } from "./observability/operational-metrics.js";
import { KraOscuClient } from "./integrations/etims/kra-oscu-client.js";
import { KraVscuClient } from "./integrations/etims/kra-vscu-client.js";
import { SimulatedEtimsAdapter } from "./infrastructure/etims/simulated-etims-adapter.js";
import {
  SimulatedTremolFiscalDevice,
  TremolSimulator,
} from "./infrastructure/device/tremol-simulator.js";
import type { FiscalizationRecord } from "./domain/fiscalization/fiscalization-record.js";
import type { EtimsReportingOperationDetails } from "./domain/fiscalization/etims-reporting.js";
import { parseZohoFiscalizationWritebackConfiguration } from "./application/zoho/zoho-fiscalization-writeback-config.js";
import { ZohoFiscalizationWritebackService } from "./application/zoho/zoho-fiscalization-writeback-service.js";
import { GracefulShutdown } from "./infrastructure/http/graceful-shutdown.js";

const databaseProvider = createFiscalizationRepositoryProvider();
const zohoWritebackConfiguration = env.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON
  ? parseZohoFiscalizationWritebackConfiguration(env.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON)
  : undefined;
const etimsPayloadKeyring: Readonly<Record<string, string>> | undefined =
  env.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON
    ? (JSON.parse(env.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON) as Record<string, string>)
    : env.ETIMS_PAYLOAD_ENCRYPTION_KEY
      ? { [env.ETIMS_PAYLOAD_ENCRYPTION_KEY_ID]: env.ETIMS_PAYLOAD_ENCRYPTION_KEY }
      : undefined;
const etimsPayloadKeyId = env.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON
  ? env.ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID
  : env.ETIMS_PAYLOAD_ENCRYPTION_KEY_ID;
const etimsPayloadVault = etimsPayloadKeyring
  ? new EtimsSubmissionPayloadVault(
      databaseProvider.etimsReportingRepository,
      new AesGcmEtimsPayloadProtection(
        new ConfiguredEtimsPayloadKeyProvider(etimsPayloadKeyring, etimsPayloadKeyId),
      ),
    )
  : undefined;

// Model selection is explicit. Both adapter implementations remain non-operational
// until their contract, enrollment, mappings, and lifecycle are verified.
const etimsReportingService = new EtimsReportingService(
  databaseProvider.etimsReportingRepository,
  env.FISCALIZATION_SIMULATION_ENABLED
    ? [new SimulatedEtimsAdapter(env.FISCALIZATION_SIMULATED_ETIMS_SCENARIO)]
    : [
        env.ETIMS_VSCU_BASE_URL
          ? new KraEtimsReportingAdapter(
              new KraVscuClient({
                baseUrl: env.ETIMS_VSCU_BASE_URL,
                timeoutMs: env.ETIMS_PROVIDER_TIMEOUT_MS,
              }),
            )
          : new UnverifiedEtimsAdapter(
              "vscu",
              env.ETIMS_ADAPTER === "vscu",
              env.ETIMS_REPORTING_ENABLED,
            ),
        env.ETIMS_OSCU_ENVIRONMENT
          ? new KraEtimsReportingAdapter(
              new KraOscuClient({
                environment: env.ETIMS_OSCU_ENVIRONMENT,
                timeoutMs: env.ETIMS_PROVIDER_TIMEOUT_MS,
              }),
            )
          : new UnverifiedEtimsAdapter(
              "oscu",
              env.ETIMS_ADAPTER === "oscu",
              env.ETIMS_REPORTING_ENABLED,
            ),
      ],
  {
    enabled: env.ETIMS_REPORTING_ENABLED || env.FISCALIZATION_SIMULATION_ENABLED,
    ...(env.FISCALIZATION_SIMULATION_ENABLED
      ? { selectedAdapterType: "vscu" as const }
      : env.ETIMS_ADAPTER
        ? { selectedAdapterType: env.ETIMS_ADAPTER }
        : {}),
    verifiedReceiptLifecycle: env.FISCALIZATION_SIMULATION_ENABLED,
    reconciliationTimeoutMs: env.ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS,
  },
  etimsPayloadVault,
);

const etimsProtocolReadiness = () => {
  if (env.FISCALIZATION_SIMULATION_ENABLED) {
    return {
      mode: "vscu" as const,
      configured: true,
      configurationValid: true,
      transportReady: "not_checked" as const,
      contractTests: "implemented_not_provider_verified" as const,
      contractVerified: false as const,
      sandboxVerified: false as const,
      providerApproved: false as const,
      liveOperationPermitted: false as const,
      blockers: ["simulated_adapter_only", "provider_contract_unverified"],
    };
  }
  if (env.ETIMS_ADAPTER === "oscu") {
    if (!env.ETIMS_OSCU_ENVIRONMENT) {
      return {
        mode: "oscu" as const,
        configured: false,
        configurationValid: false,
        transportReady: "not_checked" as const,
        contractTests: "implemented_not_provider_verified" as const,
        contractVerified: false as const,
        sandboxVerified: false as const,
        providerApproved: false as const,
        liveOperationPermitted: false as const,
        blockers: ["explicit_oscu_environment_required", "provider_contract_unverified"],
      };
    }
    return new KraOscuClient({
      environment: env.ETIMS_OSCU_ENVIRONMENT,
      timeoutMs: env.ETIMS_PROVIDER_TIMEOUT_MS,
    }).getReadiness();
  }
  if (env.ETIMS_ADAPTER === "vscu") {
    if (!env.ETIMS_VSCU_BASE_URL) {
      return {
        mode: "vscu" as const,
        configured: false,
        configurationValid: false,
        transportReady: "not_checked" as const,
        contractTests: "implemented_not_provider_verified" as const,
        contractVerified: false as const,
        sandboxVerified: false as const,
        providerApproved: false as const,
        liveOperationPermitted: false as const,
        blockers: ["local_vscu_base_url_required", "provider_contract_unverified"],
      };
    }
    return new KraVscuClient({
      baseUrl: env.ETIMS_VSCU_BASE_URL,
      timeoutMs: env.ETIMS_PROVIDER_TIMEOUT_MS,
    }).getReadiness();
  }
  return {
    mode: "unselected" as const,
    configured: false,
    configurationValid: false,
    transportReady: "not_checked" as const,
    contractTests: "implemented_not_provider_verified" as const,
    contractVerified: false as const,
    sandboxVerified: false as const,
    providerApproved: false as const,
    liveOperationPermitted: false as const,
    blockers: ["adapter_not_selected"],
  };
};

// Device communication is opt-in for read-only diagnostics. The selected
// transport supports no receipt commands and the FiscalDevice remains blocked.
const tremolClient =
  !env.FISCALIZATION_SIMULATION_ENABLED && env.TREMOL_ADAPTER === "zfplabserver_readonly"
    ? new TremolZfpLabServerClient({
        baseUrl: env.TREMOL_BASE_URL,
        timeoutMs: env.TREMOL_TIMEOUT_MS,
        transport:
          env.TREMOL_TRANSPORT === "http"
            ? new TremolHttpTransport({ timeoutMs: env.TREMOL_TIMEOUT_MS })
            : (() => {
                throw new Error("Unsupported Tremol transport configuration.");
              })(),
      })
    : undefined;
const fiscalDeviceDiagnostics = tremolClient
  ? new TremolDeviceDiagnostics(tremolClient)
  : undefined;
const tremolFiscalDevice = tremolClient
  ? new TremolFiscalDevice({
      baseUrl: env.TREMOL_BASE_URL,
      commandTimeoutMs: env.TREMOL_TIMEOUT_MS,
      client: tremolClient,
    })
  : undefined;
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
        scopes: zohoWritebackConfiguration
          ? ["ZohoBooks.invoices.READ", "ZohoBooks.invoices.UPDATE"]
          : ["ZohoBooks.invoices.READ"],
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
// Enable receipt-plan preparation only when invoice retrieval and both
// fiscal-profile repositories are available. This builds a plan only;
// it does not execute commands on the Tremol device.
const prepareTremolReceiptPlan =
  invoiceService &&
  databaseProvider.fiscalCustomerProfileRepository &&
  databaseProvider.fiscalItemProfileRepository
    ? new PrepareTremolReceiptPlan(
        databaseProvider.fiscalCustomerProfileRepository,
        databaseProvider.fiscalItemProfileRepository,
      )
    : undefined;

const registrationService = new RegisterFiscalizationRequestService(databaseProvider.repository);
const simulatedDevice = env.FISCALIZATION_SIMULATION_ENABLED
  ? new SimulatedTremolFiscalDevice(new TremolSimulator())
  : undefined;
if (simulatedDevice) {
  const outcome = env.FISCALIZATION_SIMULATED_DEVICE_SCENARIO;
  if (outcome === "unavailable") simulatedDevice.getSimulator().setConnected(false);
  else if (outcome === "success")
    simulatedDevice.getSimulator().setNextOutcome({ kind: "success" });
  else if (outcome === "failure")
    simulatedDevice.getSimulator().setNextOutcome({ kind: "failure" });
  else if (outcome === "timeout")
    simulatedDevice.getSimulator().setNextOutcome({ kind: "timeout" });
  else if (outcome === "uncertain")
    simulatedDevice.getSimulator().setNextOutcome({ kind: "outcome-unknown" });
  else if (outcome === "exception")
    simulatedDevice.getSimulator().setNextOutcome({ kind: "exception" });
}
const fiscalizationService = new FiscalizationService(
  databaseProvider.repository,
  simulatedDevice ?? tremolFiscalDevice,
  env.ZOHO_ORGANIZATION_ID ?? "",
  env.FISCALIZATION_SIMULATION_ENABLED
    ? {
        enabled: true,
        paymentSourceVerified: true,
        taxRulesVerified: true,
        deviceContractVerified: true,
        simulated: true,
      }
    : undefined,
);

const prepareFiscalizationRequestService = invoiceService
  ? new PrepareFiscalizationRequestService(invoiceService, registrationService, {
      zohoOrganizationId: env.ZOHO_ORGANIZATION_ID ?? "",
      customerProfiles: databaseProvider.fiscalCustomerProfileRepository,
      itemProfiles: databaseProvider.fiscalItemProfileRepository,
      ...(booksClient
        ? { paymentsClient: booksClient as Pick<PaymentsClient, "getInvoicePayments"> }
        : {}),
    })
  : undefined;
const simulatedWorkflowPolicy = env.FISCALIZATION_SIMULATION_ENABLED
  ? {
      simulated: true as const,
      scenarioId: `${env.FISCALIZATION_SIMULATED_SEQUENCE}:${env.FISCALIZATION_SIMULATED_DEVICE_SCENARIO}:${env.FISCALIZATION_SIMULATED_ETIMS_SCENARIO}`,
      orderedStages: (env.FISCALIZATION_SIMULATED_SEQUENCE === "device_then_etims"
        ? ["device", "etims"]
        : ["etims", "device"]) as ["device" | "etims", "device" | "etims"],
      mayContinue: (
        stage: "device" | "etims",
        result: FiscalizationRecord | EtimsReportingOperationDetails,
      ) => {
        if (stage === "device") {
          return "status" in result && result.status === "Succeeded";
        }
        return "operation" in result && result.operation.status === "accepted";
      },
    }
  : undefined;
const fiscalizationOrchestrationService = new FiscalizationOrchestrationService(
  databaseProvider.repository,
  prepareFiscalizationRequestService,
  fiscalizationService,
  etimsReportingService,
  simulatedWorkflowPolicy,
);
const zohoWritebackService =
  booksClient && zohoWritebackConfiguration
    ? new ZohoFiscalizationWritebackService(
        databaseProvider.repository,
        etimsReportingService,
        databaseProvider.zohoFiscalizationWritebackRepository,
        booksClient,
        zohoWritebackConfiguration,
      )
    : undefined;
// No evidence verifier is configured here; submitted operator evidence remains
// unresolved/invalid until a contract-backed verifier is installed.
const manualReviewService = new ManualReviewService(
  databaseProvider.repository,
  databaseProvider.manualReviewRepository,
  etimsReportingService,
);

const etimsReconciliationWorker = startConfiguredEtimsReconciliationWorker({
  service: etimsReportingService,
  payloadResolver: etimsPayloadVault ?? {
    load: async () => ({ available: false }),
  },
  enabled: env.ETIMS_RECONCILIATION_ENABLED && env.ETIMS_REPORTING_ENABLED,
  intervalMs: env.ETIMS_RECONCILIATION_INTERVAL_MS,
  batchSize: env.ETIMS_RECONCILIATION_BATCH_SIZE,
  maxAttempts: env.ETIMS_RECONCILIATION_MAX_ATTEMPTS,
  staleAgeMs: env.ETIMS_RECONCILIATION_STALE_AGE_MS,
  operationTimeoutMs: env.ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS,
  maxRuntimeMs: env.ETIMS_RECONCILIATION_MAX_RUNTIME_MS,
  metrics: operationalMetrics,
});

if (etimsReconciliationWorker.health.enabled && !etimsReconciliationWorker.health.started) {
  logger.warn(
    { reason: etimsReconciliationWorker.health.reason },
    "eTIMS reconciliation worker is enabled but unavailable; no provider calls will be made",
  );
} else if (!etimsReconciliationWorker.health.enabled) {
  logger.info("eTIMS reconciliation worker is disabled");
}
const invoiceImportService =
  booksClient && prepareFiscalizationRequestService
    ? new ImportZohoInvoicesService(booksClient, prepareFiscalizationRequestService, {
        pageSize: env.ZOHO_SYNC_PAGE_SIZE,
        maxPages: env.ZOHO_SYNC_MAX_PAGES,
      })
    : undefined;
const zohoInvoiceSynchronizationService =
  invoiceImportService && env.ZOHO_ORGANIZATION_ID
    ? new ZohoInvoiceSynchronizationService(
        env.ZOHO_ORGANIZATION_ID,
        invoiceImportService,
        databaseProvider.zohoSyncRepository,
        { automaticEnabled: env.ZOHO_SYNC_ENABLED },
      )
    : undefined;

const app = createApp({
  checkDatabaseConnection: databaseProvider.checkConnection,
  dependencyHealthTimeoutMs: env.DEPENDENCY_HEALTH_TIMEOUT_MS,
  isShuttingDown: () => shutdownLifecycle.isDraining(),
  fiscalizationRepository: databaseProvider.repository,
  fiscalizationService,
  ...(oauthService ? { oauthService } : {}),
  ...(booksClient ? { booksClient } : {}),
  ...(invoiceService ? { invoiceService } : {}),
  ...(prepareFiscalizationRequestService ? { prepareFiscalizationRequestService } : {}),
  ...(invoiceImportService ? { invoiceImportService } : {}),
  ...(zohoInvoiceSynchronizationService ? { zohoInvoiceSynchronizationService } : {}),
  ...(prepareTremolReceiptPlan ? { prepareTremolReceiptPlan } : {}),
  fiscalCustomerProfileRepository: databaseProvider.fiscalCustomerProfileRepository,
  fiscalItemProfileRepository: databaseProvider.fiscalItemProfileRepository,
  ...(fiscalDeviceDiagnostics ? { fiscalDeviceDiagnostics } : {}),
  etimsReportingService,
  etimsProtocolReadiness,
  etimsReconciliationHealth: () => ({
    ...etimsReconciliationWorker.health,
    job: operationalMetrics.snapshot().jobs["etims_reconciliation"] ?? null,
  }),
  fiscalizationOrchestrationService,
  ...(zohoWritebackService ? { zohoWritebackService } : {}),
  manualReviewService,
});

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info(
    {
      port: env.PORT,
      host: env.HOST,
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
const zohoInvoiceSyncWorker =
  env.ZOHO_SYNC_ENABLED && zohoInvoiceSynchronizationService
    ? startZohoInvoiceSyncWorker({
        service: zohoInvoiceSynchronizationService,
        intervalMs: env.ZOHO_SYNC_INTERVAL_MS,
      })
    : undefined;
const shutdownLifecycle = new GracefulShutdown({
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  stopAcceptingRequests: () =>
    new Promise<void>((resolve, reject) => {
      server.close((serverError) => {
        if (serverError) reject(serverError);
        else resolve();
      });
    }),
  stopBackgroundWork: async () => {
    const results = await Promise.allSettled([
      oauthAttemptCleanup.stop(),
      staleFiscalizationRecoveryWorker?.stop() ?? Promise.resolve(),
      zohoInvoiceSyncWorker?.stop() ?? Promise.resolve(),
      etimsReconciliationWorker.stop(),
    ]);
    const failedCount = results.filter((result) => result.status === "rejected").length;
    if (failedCount > 0) {
      logger.error(
        { failedWorkerCount: failedCount },
        "One or more background workers failed to stop",
      );
      throw new Error("Background worker shutdown failed");
    }
    logger.info("Background workers stopped");
  },
  closeDependencies: async () => {
    await tremolClient?.close();
    await databaseProvider.disconnect();
    logger.info("Database client disconnected");
  },
  forceCloseRequests: () => server.closeAllConnections(),
  onTimeout: () => {
    process.exitCode = 1;
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "Graceful shutdown timed out");
  },
});

function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown requested");
  void shutdownLifecycle.start().then(
    () => logger.info("HTTP server and application dependencies closed"),
    () => {
      process.exitCode = 1;
      logger.error("Application shutdown did not complete safely");
    },
  );
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
