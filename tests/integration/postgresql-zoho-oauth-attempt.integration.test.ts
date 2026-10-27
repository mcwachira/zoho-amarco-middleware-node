import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlZohoOAuthAttemptRepository } from "../../src/infrastructure/database/postgresql-zoho-oauth-attempt-repository.js";

const integrationEnabled = process.env["RUN_POSTGRES_OAUTH_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("PostgreSQL Zoho OAuth attempt repository (integration)", () => {
  const testStateHashes: string[] = [];

  let prisma: ReturnType<typeof createPostgresqlClient>;
  let repository: PostgresqlZohoOAuthAttemptRepository;

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

    // Require a clearly dedicated test database, not the development database.
    if (parsedUrl.port !== "5438" || parsedUrl.pathname !== "/zoho_amarco_test") {
      throw new Error("OAuth integration tests require zoho_amarco_test on localhost port 5438.");
    }

    prisma = createPostgresqlClient(connectionString);
    repository = new PostgresqlZohoOAuthAttemptRepository(prisma);

    await prisma.$connect();
  });

  afterEach(async () => {
    // Remove only OAuth attempts created by this test, never the whole table.
    if (testStateHashes.length > 0) {
      await prisma.zohoOAuthAttempt.deleteMany({
        where: { stateHash: { in: [...testStateHashes] } },
      });

      testStateHashes.length = 0;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  it("allows only one concurrent request to consume an OAuth attempt", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const stateHash = randomBytes(32).toString("hex");
    const encryptedCodeVerifier = `integration-test-${randomUUID()}`;

    testStateHashes.push(stateHash);

    await repository.create({
      stateHash,
      encryptedCodeVerifier,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
    });

    const results = await Promise.all([
      repository.consume(stateHash, now),
      repository.consume(stateHash, now),
    ]);

    const successfulResults = results.filter((result) => result !== null);
    const unsuccessfulResults = results.filter((result) => result === null);

    expect(successfulResults).toHaveLength(1);
    expect(unsuccessfulResults).toHaveLength(1);
    expect(successfulResults[0]).toEqual({ encryptedCodeVerifier });

    const storedAttempt = await prisma.zohoOAuthAttempt.findUnique({
      where: { stateHash },
      select: { consumedAt: true },
    });

    expect(storedAttempt?.consumedAt).not.toBeNull();
  });

  it("enforces unique OAuth state hashes", async () => {
    const stateHash = randomBytes(32).toString("hex");
    const encryptedCodeVerifier = `integration-test-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    testStateHashes.push(stateHash);

    await repository.create({ stateHash, encryptedCodeVerifier, expiresAt });

    await expect(
      repository.create({
        stateHash,
        encryptedCodeVerifier: `duplicate-${randomUUID()}`,
        expiresAt,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
