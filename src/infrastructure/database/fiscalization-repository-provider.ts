import type { FiscalizationRepository } from "../../application/fiscalization/fiscalization-repository.js";
import { env } from "../../config/env.js";
import { PostgresqlFiscalizationRepository } from "./postgresql-fiscalization-repository.js";
import { SqlServerFiscalizationRepository } from "./sqlserver-fiscalization-repository.js";
import { createPostgresqlClient } from "./postgresql-client.js";
import { createSqlServerClient } from "./sqlserver-client.js";

type SqlServerConfig = Parameters<typeof createSqlServerClient>[0];

export interface FiscalizationRepositoryProvider {
  readonly repository: FiscalizationRepository;
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

      const client = createPostgresqlClient(connectionString);
      const repository = new PostgresqlFiscalizationRepository(client);

      return {
        repository,
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

      const client = createSqlServerClient(config);
      const repository = new SqlServerFiscalizationRepository(client);

      return {
        repository,
        checkConnection: async () => {
          await client.$queryRaw`SELECT 1`;
        },
        disconnect: () => client.$disconnect(),
      };
    }
  }
}
