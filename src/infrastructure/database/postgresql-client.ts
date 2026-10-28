import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/postgresql/client.js";

/**
 * Creates a PostgreSQL Prisma Client.
 *
 * The caller supplies the connection string so this module
 * does not depend on environment variables or application startup.
 */

export function createPostgresqlClient(
  connectionString: string,
  timeouts: {
    readonly connectionTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
  } = {},
): PrismaClient {
  if (connectionString.trim() === "") {
    throw new Error("PostgreSQL connection string cannot be empty");
  }

  const adapter = new PrismaPg({
    connectionString,
    connectionTimeoutMillis: timeouts.connectionTimeoutMs ?? 5_000,
    statement_timeout: timeouts.statementTimeoutMs ?? 30_000,
  });

  return new PrismaClient({ adapter });
}
