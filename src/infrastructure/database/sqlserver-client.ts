import { PrismaMssql } from "@prisma/adapter-mssql";
import { PrismaClient } from "../../generated/prisma/sqlserver/client.js";

/**
 * Creates a SQL Server Prisma Client.
 *
 * The caller supplies the SQL Server configuration.
 * This factory does not run migrations or execute queries.
 */
export function createSqlServerClient(
  config: ConstructorParameters<typeof PrismaMssql>[0],
): PrismaClient {
  const adapter = new PrismaMssql(config);

  return new PrismaClient({ adapter });
}
