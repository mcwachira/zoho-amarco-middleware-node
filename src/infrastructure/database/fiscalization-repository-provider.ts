import type { FiscalizationRepository } from "../../application/fiscalization/fiscalization-repository.js";
import type { ZohoOAuthAttemptRepository } from "../../application/zoho/oauth-attempt-repository.js";
import { env } from "../../config/env.js";
import { PostgresqlFiscalizationRepository } from "./postgresql-fiscalization-repository.js";
import { PostgresqlZohoOAuthAttemptRepository } from "./postgresql-zoho-oauth-attempt-repository.js";
import { createPostgresqlClient } from "./postgresql-client.js";
import type { ZohoTokenRepository } from "../../application/zoho/zoho-token-repository.js";
import { PostgresqlZohoTokenRepository } from "./postgresql-zoho-token-repository.js";
import type { FiscalCustomerProfileRepository } from "../../application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "../../application/fiscalization/fiscal-item-profile-repository.js";
import { PostgresqlFiscalCustomerProfileRepository } from "./postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "./postgresql-fiscal-item-profile-repository.js";
import type { ZohoSyncRepository } from "../../application/zoho/zoho-sync-repository.js";
import { PostgresqlZohoSyncRepository } from "./postgresql-zoho-sync-repository.js";
import type { EtimsReportingRepository } from "../../application/fiscalization/etims-reporting-repository.js";
import { PostgresqlEtimsReportingRepository } from "./postgresql-etims-reporting-repository.js";
import type { ManualReviewRepository } from "../../application/fiscalization/manual-review-repository.js";
import { PostgresqlManualReviewRepository } from "./postgresql-manual-review-repository.js";
import type { KraReferenceSyncRepository } from "../../application/etims/kra-reference-sync-repository.js";
import { PostgresqlKraReferenceSyncRepository } from "./postgresql-kra-reference-sync-repository.js";
import type { ZohoFiscalizationWritebackRepository } from "../../application/zoho/zoho-fiscalization-writeback-repository.js";
import { PostgresqlZohoFiscalizationWritebackRepository } from "./postgresql-zoho-writeback-repository.js";

export interface FiscalizationRepositoryProvider {
  readonly repository: FiscalizationRepository;
  readonly oauthAttemptRepository: ZohoOAuthAttemptRepository;
  readonly zohoTokenRepository: ZohoTokenRepository;
  readonly fiscalCustomerProfileRepository: FiscalCustomerProfileRepository;
  readonly fiscalItemProfileRepository: FiscalItemProfileRepository;
  readonly zohoSyncRepository: ZohoSyncRepository;
  readonly etimsReportingRepository: EtimsReportingRepository;
  readonly manualReviewRepository: ManualReviewRepository;
  readonly kraReferenceSyncRepository: KraReferenceSyncRepository;
  readonly zohoFiscalizationWritebackRepository: ZohoFiscalizationWritebackRepository;
  checkConnection(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createFiscalizationRepositoryProvider(): FiscalizationRepositoryProvider {
  const connectionString = env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is required for PostgreSQL");
  }

  // All repositories share this Prisma client and its connection pool.
  const client = createPostgresqlClient(connectionString, {
    connectionTimeoutMs: env.POSTGRES_CONNECT_TIMEOUT_MS,
    statementTimeoutMs: env.POSTGRES_STATEMENT_TIMEOUT_MS,
  });

  const repository = new PostgresqlFiscalizationRepository(client);
  const oauthAttemptRepository = new PostgresqlZohoOAuthAttemptRepository(client);
  const zohoTokenRepository = new PostgresqlZohoTokenRepository(client);
  const fiscalCustomerProfileRepository = new PostgresqlFiscalCustomerProfileRepository(client);
  const fiscalItemProfileRepository = new PostgresqlFiscalItemProfileRepository(client);
  const zohoSyncRepository = new PostgresqlZohoSyncRepository(client);
  const etimsReportingRepository = new PostgresqlEtimsReportingRepository(client);
  const manualReviewRepository = new PostgresqlManualReviewRepository(client);
  const kraReferenceSyncRepository = new PostgresqlKraReferenceSyncRepository(client);
  const zohoFiscalizationWritebackRepository = new PostgresqlZohoFiscalizationWritebackRepository(
    client,
  );

  return {
    repository,
    oauthAttemptRepository,
    zohoTokenRepository,
    fiscalCustomerProfileRepository,
    fiscalItemProfileRepository,
    zohoSyncRepository,
    etimsReportingRepository,
    manualReviewRepository,
    kraReferenceSyncRepository,
    zohoFiscalizationWritebackRepository,
    checkConnection: async () => {
      await client.$queryRaw`SELECT 1`;
    },
    disconnect: () => client.$disconnect(),
  };
}
