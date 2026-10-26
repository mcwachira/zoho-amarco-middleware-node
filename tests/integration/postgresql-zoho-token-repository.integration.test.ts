import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlZohoTokenRepository } from "../../src/infrastructure/database/postgresql-zoho-token-repository.js";

const integrationEnabled = process.env["RUN_POSTGRES_OAUTH_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("PostgreSQL Zoho token repository (integration)", () => {
  let prisma: ReturnType<typeof createPostgresqlClient>;
  let repository: PostgresqlZohoTokenRepository;

  beforeAll(async () => {
    const connectionString = process.env["ZOHO_OAUTH_TEST_DATABASE_URL"];

    if (!connectionString) {
      throw new Error("ZOHO_OAUTH_TEST_DATABASE_URL is required to run OAuth integration tests.");
    }

    const parsedUrl = new URL(connectionString);

    // Never run this test against a remote database.
    if (parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
      throw new Error("OAuth integration tests are restricted to local PostgreSQL.");
    }

    // Require the dedicated test database, not a development database.
    if (parsedUrl.port !== "5438" || parsedUrl.pathname !== "/zoho_amarco_test") {
      throw new Error("OAuth integration tests require zoho_amarco_test on localhost port 5438.");
    }

    prisma = createPostgresqlClient(connectionString);
    repository = new PostgresqlZohoTokenRepository(prisma);
    await prisma.$connect();
  });

  afterAll(async () => {
    if (prisma) {
      // The token repository intentionally supports one connection per
      // installation, so remove only its dedicated test record.
      await prisma.zohoToken.deleteMany({
        where: { id: "primary" },
      });
      await prisma.$disconnect();
    }
  });

  it("persists tokens and preserves the refresh token when an update omits it", async () => {
    const suffix = randomUUID();

    const initialTokens = {
      encryptedAccessToken: `integration-access-${suffix}`,
      encryptedRefreshToken: `integration-refresh-${suffix}`,
      accessTokenExpiresAt: new Date("2026-10-25T13:00:00.000Z"),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    };

    await repository.save(initialTokens);

    const storedInitial = await repository.get();

    expect(storedInitial).not.toBeNull();
    expect(storedInitial).toMatchObject(initialTokens);

    // Simulate a refresh response that does not include a replacement
    // refresh token. The database update must preserve the original.
    const refreshedTokens = {
      encryptedAccessToken: `integration-refreshed-access-${suffix}`,
      accessTokenExpiresAt: new Date("2026-10-25T14:00:00.000Z"),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    };

    await repository.save(refreshedTokens);

    const storedRefreshed = await repository.get();

    expect(storedRefreshed).not.toBeNull();
    expect(storedRefreshed).toMatchObject({
      ...refreshedTokens,
      encryptedRefreshToken: initialTokens.encryptedRefreshToken,
    });
  });
});
