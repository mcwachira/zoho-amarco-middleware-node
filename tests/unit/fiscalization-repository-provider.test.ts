import { afterEach, describe, expect, it, vi } from "vitest";

// Hoist mocks so they are available when the provider's imports are evaluated.
const mocks = vi.hoisted(() => {
  const client = {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  };

  return {
    client,
    env: {
      DATABASE_PROVIDER: "postgresql" as "postgresql" | "sqlserver",
      DATABASE_URL: "postgresql://example.invalid/test",
      SQLSERVER_SERVER: "sql.example.invalid",
      SQLSERVER_DATABASE: "test",
      SQLSERVER_USER: "test-user",
      SQLSERVER_PASSWORD: "test-password",
      SQLSERVER_PORT: 1433,
      SQLSERVER_ENCRYPT: "true" as "true" | "false",
      SQLSERVER_TRUST_SERVER_CERTIFICATE: "false" as "true" | "false",
    },
    createPostgresqlClient: vi.fn(),
    createSqlServerClient: vi.fn(),
    postgresqlFiscalizationRepository: vi.fn(),
    sqlServerFiscalizationRepository: vi.fn(),
    postgresqlOAuthAttemptRepository: vi.fn(),
    sqlServerOAuthAttemptRepository: vi.fn(),
    postgresqlZohoTokenRepository: vi.fn(),
    sqlServerZohoTokenRepository: vi.fn(),
  };
});

vi.mock("../../src/config/env.js", () => ({
  env: mocks.env,
}));

vi.mock("../../src/infrastructure/database/postgresql-client.js", () => ({
  createPostgresqlClient: mocks.createPostgresqlClient,
}));

vi.mock("../../src/infrastructure/database/sqlserver-client.js", () => ({
  createSqlServerClient: mocks.createSqlServerClient,
}));

vi.mock("../../src/infrastructure/database/postgresql-fiscalization-repository.js", () => ({
  PostgresqlFiscalizationRepository: mocks.postgresqlFiscalizationRepository,
}));

vi.mock("../../src/infrastructure/database/sqlserver-fiscalization-repository.js", () => ({
  SqlServerFiscalizationRepository: mocks.sqlServerFiscalizationRepository,
}));

vi.mock("../../src/infrastructure/database/postgresql-zoho-oauth-attempt-repository.js", () => ({
  PostgresqlZohoOAuthAttemptRepository: mocks.postgresqlOAuthAttemptRepository,
}));

vi.mock("../../src/infrastructure/database/sqlserver-zoho-oauth-attempt-repository.js", () => ({
  SqlServerZohoOAuthAttemptRepository: mocks.sqlServerOAuthAttemptRepository,
}));

vi.mock("../../src/infrastructure/database/postgresql-zoho-token-repository.js", () => ({
  PostgresqlZohoTokenRepository: mocks.postgresqlZohoTokenRepository,
}));

vi.mock("../../src/infrastructure/database/sqlserver-zoho-token-repository.js", () => ({
  SqlServerZohoTokenRepository: mocks.sqlServerZohoTokenRepository,
}));

// Import after declaring the mocks. Vitest hoists vi.mock calls.
import { createFiscalizationRepositoryProvider } from "../../src/infrastructure/database/fiscalization-repository-provider.js";

describe("createFiscalizationRepositoryProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function configureMockConstructors() {
    mocks.createPostgresqlClient.mockReturnValue(mocks.client);
    mocks.createSqlServerClient.mockReturnValue(mocks.client);

    // Vitest's mockImplementation expects a callable function. Use
    // constructible functions because the provider invokes these with `new`.
    mocks.postgresqlFiscalizationRepository.mockImplementation(
      function PostgresqlFiscalizationRepository() {
        return { kind: "postgresql-fiscalization" };
      },
    );
    mocks.sqlServerFiscalizationRepository.mockImplementation(
      function SqlServerFiscalizationRepository() {
        return { kind: "sqlserver-fiscalization" };
      },
    );

    mocks.postgresqlOAuthAttemptRepository.mockImplementation(
      function PostgresqlZohoOAuthAttemptRepository() {
        return { kind: "postgresql-oauth-attempt" };
      },
    );
    mocks.sqlServerOAuthAttemptRepository.mockImplementation(
      function SqlServerZohoOAuthAttemptRepository() {
        return { kind: "sqlserver-oauth-attempt" };
      },
    );

    mocks.postgresqlZohoTokenRepository.mockImplementation(
      function PostgresqlZohoTokenRepository() {
        return { kind: "postgresql-zoho-token" };
      },
    );
    mocks.sqlServerZohoTokenRepository.mockImplementation(function SqlServerZohoTokenRepository() {
      return { kind: "sqlserver-zoho-token" };
    });
  }

  it("wires all PostgreSQL repositories to the PostgreSQL client", async () => {
    configureMockConstructors();
    mocks.env.DATABASE_PROVIDER = "postgresql";

    const provider = createFiscalizationRepositoryProvider();

    expect(mocks.createPostgresqlClient).toHaveBeenCalledWith("postgresql://example.invalid/test");
    expect(mocks.createSqlServerClient).not.toHaveBeenCalled();

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

    mocks.client.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await provider.checkConnection();
    expect(mocks.client.$queryRaw).toHaveBeenCalledTimes(1);

    mocks.client.$disconnect.mockResolvedValueOnce(undefined);
    await provider.disconnect();
    expect(mocks.client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("wires all SQL Server repositories to the SQL Server client", async () => {
    configureMockConstructors();
    mocks.env.DATABASE_PROVIDER = "sqlserver";

    const provider = createFiscalizationRepositoryProvider();

    expect(mocks.createSqlServerClient).toHaveBeenCalledWith({
      server: "sql.example.invalid",
      database: "test",
      user: "test-user",
      password: "test-password",
      port: 1433,
      options: {
        encrypt: true,
        trustServerCertificate: false,
      },
    });
    expect(mocks.createPostgresqlClient).not.toHaveBeenCalled();

    expect(mocks.sqlServerFiscalizationRepository).toHaveBeenCalledWith(mocks.client);
    expect(mocks.sqlServerOAuthAttemptRepository).toHaveBeenCalledWith(mocks.client);
    expect(mocks.sqlServerZohoTokenRepository).toHaveBeenCalledWith(mocks.client);

    expect(provider.repository).toEqual({
      kind: "sqlserver-fiscalization",
    });
    expect(provider.oauthAttemptRepository).toEqual({
      kind: "sqlserver-oauth-attempt",
    });
    expect(provider.zohoTokenRepository).toEqual({
      kind: "sqlserver-zoho-token",
    });

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

  it("rejects incomplete SQL Server configuration", () => {
    mocks.env.DATABASE_PROVIDER = "sqlserver";
    mocks.env.SQLSERVER_PASSWORD = undefined as unknown as string;

    expect(() => createFiscalizationRepositoryProvider()).toThrow(
      "SQL Server connection settings are incomplete",
    );
    expect(mocks.createSqlServerClient).not.toHaveBeenCalled();
  });
});
