import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresqlFiscalCustomerProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-item-profile-repository.js";
import { PostgresqlEtimsReportingRepository } from "../../src/infrastructure/database/postgresql-etims-reporting-repository.js";

// Hoist mocks so they are available when the provider's imports are evaluated.
const mocks = vi.hoisted(() => {
  const client = {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  };

  return {
    client,
    env: {
      DATABASE_PROVIDER: "postgresql",
      DATABASE_URL: "postgresql://example.invalid/test",
      POSTGRES_CONNECT_TIMEOUT_MS: 5_000,
      POSTGRES_STATEMENT_TIMEOUT_MS: 30_000,
    },
    createPostgresqlClient: vi.fn(),
    postgresqlFiscalizationRepository: vi.fn(),
    postgresqlOAuthAttemptRepository: vi.fn(),
    postgresqlZohoTokenRepository: vi.fn(),
  };
});

vi.mock("../../src/config/env.js", () => ({
  env: mocks.env,
}));

vi.mock("../../src/infrastructure/database/postgresql-client.js", () => ({
  createPostgresqlClient: mocks.createPostgresqlClient,
}));

vi.mock("../../src/infrastructure/database/postgresql-fiscalization-repository.js", () => ({
  PostgresqlFiscalizationRepository: mocks.postgresqlFiscalizationRepository,
}));

vi.mock("../../src/infrastructure/database/postgresql-zoho-oauth-attempt-repository.js", () => ({
  PostgresqlZohoOAuthAttemptRepository: mocks.postgresqlOAuthAttemptRepository,
}));

vi.mock("../../src/infrastructure/database/postgresql-zoho-token-repository.js", () => ({
  PostgresqlZohoTokenRepository: mocks.postgresqlZohoTokenRepository,
}));

// Import after declaring the mocks. Vitest hoists vi.mock calls.
import { createFiscalizationRepositoryProvider } from "../../src/infrastructure/database/fiscalization-repository-provider.js";

describe("createFiscalizationRepositoryProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function configureMockConstructors() {
    mocks.createPostgresqlClient.mockReturnValue(mocks.client);

    // Vitest's mockImplementation expects a callable function. Use
    // constructible functions because the provider invokes these with `new`.
    mocks.postgresqlFiscalizationRepository.mockImplementation(
      function PostgresqlFiscalizationRepository() {
        return { kind: "postgresql-fiscalization" };
      },
    );

    mocks.postgresqlOAuthAttemptRepository.mockImplementation(
      function PostgresqlZohoOAuthAttemptRepository() {
        return { kind: "postgresql-oauth-attempt" };
      },
    );

    mocks.postgresqlZohoTokenRepository.mockImplementation(
      function PostgresqlZohoTokenRepository() {
        return { kind: "postgresql-zoho-token" };
      },
    );
  }

  it("wires all PostgreSQL repositories to the PostgreSQL client", async () => {
    configureMockConstructors();
    mocks.env.DATABASE_PROVIDER = "postgresql";
    mocks.env.POSTGRES_CONNECT_TIMEOUT_MS = 7_500;
    mocks.env.POSTGRES_STATEMENT_TIMEOUT_MS = 45_000;

    const provider = createFiscalizationRepositoryProvider();

    expect(mocks.createPostgresqlClient).toHaveBeenCalledWith("postgresql://example.invalid/test", {
      connectionTimeoutMs: 7_500,
      statementTimeoutMs: 45_000,
    });

    expect(mocks.postgresqlFiscalizationRepository).toHaveBeenCalledWith(mocks.client);
    expect(mocks.postgresqlOAuthAttemptRepository).toHaveBeenCalledWith(mocks.client);
    expect(mocks.postgresqlZohoTokenRepository).toHaveBeenCalledWith(mocks.client);

    expect(provider.repository).toEqual({
      kind: "postgresql-fiscalization",
    });
    expect(provider.oauthAttemptRepository).toEqual({
      kind: "postgresql-oauth-attempt",
    });
    expect(provider.zohoTokenRepository).toEqual({
      kind: "postgresql-zoho-token",
    });
    expect(provider.fiscalCustomerProfileRepository).toBeInstanceOf(
      PostgresqlFiscalCustomerProfileRepository,
    );
    expect(provider.fiscalItemProfileRepository).toBeInstanceOf(
      PostgresqlFiscalItemProfileRepository,
    );
    expect(provider.etimsReportingRepository).toBeInstanceOf(PostgresqlEtimsReportingRepository);

    mocks.client.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await provider.checkConnection();
    expect(mocks.client.$queryRaw).toHaveBeenCalledTimes(1);

    mocks.client.$disconnect.mockResolvedValueOnce(undefined);
    await provider.disconnect();
    expect(mocks.client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects PostgreSQL configuration without a connection string", () => {
    mocks.env.DATABASE_PROVIDER = "postgresql";
    mocks.env.DATABASE_URL = undefined as unknown as string;

    expect(() => createFiscalizationRepositoryProvider()).toThrow(
      "DATABASE_URL is required for PostgreSQL",
    );
    expect(mocks.createPostgresqlClient).not.toHaveBeenCalled();
  });
});
