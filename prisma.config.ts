import "dotenv/config";
import { defineConfig } from "prisma/config";

const schema = process.env["PRISMA_SCHEMA"] ?? "prisma/postgresql/schema.prisma";

export default defineConfig({
  schema,

  // Keep each database provider's migration history separate.
  migrations: {
    path: process.env["PRISMA_MIGRATIONS_PATH"] ?? "prisma/postgresql/migrations",
  },

  datasource: {
    url: process.env["DATABASE_URL"] ?? "",
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
