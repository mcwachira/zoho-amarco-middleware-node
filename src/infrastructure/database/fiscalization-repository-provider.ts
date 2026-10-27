import type { FiscalizationRepository } from "../../application/fiscalization/fiscalization-repository.js";
import type { ZohoOAuthAttemptRepository } from "../../application/zoho/oauth-attempt-repository.js";
import { env } from "../../config/env.js";
import { PostgresqlFiscalizationRepository } from "./postgresql-fiscalization-repository.js";
import { SqlServerFiscalizationRepository } from "./sqlserver-fiscalization-repository.js";
import { PostgresqlZohoOAuthAttemptRepository } from "./postgresql-zoho-oauth-attempt-repository.js";
import { SqlServerZohoOAuthAttemptRepository } from "./sqlserver-zoho-oauth-attempt-repository.js";
import { createPostgresqlClient } from "./postgresql-client.js";
import { createSqlServerClient } from "./sqlserver-client.js";
import type { ZohoTokenRepository } from "../../application/zoho/zoho-token-repository.js";
import { PostgresqlZohoTokenRepository } from "./postgresql-zoho-token-repository.js";
import { SqlServerZohoTokenRepository } from "./sqlserver-zoho-token-repository.js";
import type { FiscalCustomerProfileRepository } from "../../application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "../../application/fiscalization/fiscal-item-profile-repository.js";
import { PostgresqlFiscalCustomerProfileRepository } from "./postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "./postgresql-fiscal-item-profile-repository.js";
import { SqlServerFiscalCustomerProfileRepository } from "./sqlserver-fiscal-customer-profile-repository.js";
import { SqlServerFiscalItemProfileRepository } from "./sqlserver-fiscal-item-profile-repository.js";
import type { ZohoSyncRepository } from "../../application/zoho/zoho-sync-repository.js";
import { PostgresqlZohoSyncRepository } from "./postgresql-zoho-sync-repository.js";
import { SqlServerZohoSyncRepository } from "./sqlserver-zoho-sync-repository.js";
import type { EtimsReportingRepository } from "../../application/fiscalization/etims-reporting-repository.js";
import { PostgresqlEtimsReportingRepository } from "./postgresql-etims-reporting-repository.js";
import { SqlServerEtimsReportingRepository } from "./sqlserver-etims-reporting-repository.js";

type SqlServerConfig = Parameters<typeof createSqlServerClient>[0];

export interface FiscalizationRepositoryProvider {
  readonly repository: FiscalizationRepository;
  readonly oauthAttemptRepository: ZohoOAuthAttemptRepository;
  readonly zohoTokenRepository: ZohoTokenRepository;
  readonly fiscalCustomerProfileRepository: FiscalCustomerProfileRepository;
  readonly fiscalItemProfileRepository: FiscalItemProfileRepository;
  readonly zohoSyncRepository: ZohoSyncRepository;
  readonly etimsReportingRepository: EtimsReportingRepository;
  checkConnection(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createFiscalizationRepositoryProvider(): FiscalizationRepositoryProvider {
  switch (env.DATABASE_PROVIDER) {
    case "postgresql": {
      const connectionString = env.DATABASE_URL;

      if (!connectionString) {
        throw new Error("DATABASE_URL is required for PostgreSQL");
      }

      // Both repositories share this Prisma client and its connection pool.
      const client = createPostgresqlClient(connectionString);

      const repository = new PostgresqlFiscalizationRepository(client);
      const oauthAttemptRepository = new PostgresqlZohoOAuthAttemptRepository(client);
      const zohoTokenRepository = new PostgresqlZohoTokenRepository(client);
      const fiscalCustomerProfileRepository = new PostgresqlFiscalCustomerProfileRepository(client);
      const fiscalItemProfileRepository = new PostgresqlFiscalItemProfileRepository(client);
      const zohoSyncRepository = new PostgresqlZohoSyncRepository(client);
      const etimsReportingRepository = new PostgresqlEtimsReportingRepository(client);

      return {
        repository,
        oauthAttemptRepository,
        zohoTokenRepository,
        fiscalCustomerProfileRepository,
        fiscalItemProfileRepository,
        zohoSyncRepository,
        etimsReportingRepository,
        checkConnection: async () => {
          await client.$queryRaw`SELECT 1`;
        },
        disconnect: () => client.$disconnect(),
      };
    }

    case "sqlserver": {
      const server = env.SQLSERVER_SERVER;
      const database = env.SQLSERVER_DATABASE;
      const user = env.SQLSERVER_USER;
      const password = env.SQLSERVER_PASSWORD;

      if (!server || !database || !user || !password) {
        throw new Error("SQL Server connection settings are incomplete");
      }

      const config: SqlServerConfig = {
        server,
        database,
        user,
        password,
        port: env.SQLSERVER_PORT,
        options: {
          encrypt: env.SQLSERVER_ENCRYPT === "true",
          trustServerCertificate: env.SQLSERVER_TRUST_SERVER_CERTIFICATE === "true",
        },
      };

      // Both repositories share this Prisma client and its connection pool.
      const client = createSqlServerClient(config);

      const repository = new SqlServerFiscalizationRepository(client);
      const oauthAttemptRepository = new SqlServerZohoOAuthAttemptRepository(client);
      const zohoTokenRepository = new SqlServerZohoTokenRepository(client);
      const fiscalCustomerProfileRepository = new SqlServerFiscalCustomerProfileRepository(client);
      const fiscalItemProfileRepository = new SqlServerFiscalItemProfileRepository(client);
      const zohoSyncRepository = new SqlServerZohoSyncRepository(client);
      const etimsReportingRepository = new SqlServerEtimsReportingRepository(client);

      return {
        repository,
        oauthAttemptRepository,
        zohoTokenRepository,
        fiscalCustomerProfileRepository,
        fiscalItemProfileRepository,
        zohoSyncRepository,
        etimsReportingRepository,
        checkConnection: async () => {
          await client.$queryRaw`SELECT 1`;
        },
        disconnect: () => client.$disconnect(),
      };
    }

    default:
      throw new Error("Unsupported DATABASE_PROVIDER value.");
  }
}
