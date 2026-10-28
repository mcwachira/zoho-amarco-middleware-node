import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import {
  EnvironmentConfigurationError,
  envSchema,
  parseEnvironment,
} from "../../src/config/env.js";

describe("Environment configuration", () => {
  // Use a valid baseline so each test focuses on the setting being checked.
  const validEnvironment = {
    DATABASE_PROVIDER: "postgresql",
    DATABASE_URL: "postgresql://test:test@localhost:5432/zoho_amarco_test",
  };

  it("keeps the checked-in environment example parseable by startup validation", () => {
    const example = parseDotenv(readFileSync(resolve(process.cwd(), ".env.example"), "utf8"));

    expect(() => parseEnvironment(example)).not.toThrow();
  });

  it("disables stale fiscalization recovery by default", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.FISCALIZATION_RECOVERY_ENABLED).toBe(false);
    expect(result.FISCALIZATION_RECOVERY_INTERVAL_MS).toBe(300_000);
    expect(result.FISCALIZATION_RECOVERY_STALE_AGE_MS).toBe(1_800_000);
  });

  it("keeps simulation explicit, deterministic, and unavailable in production", () => {
    const defaults = envSchema.parse(validEnvironment);
    expect(defaults.FISCALIZATION_SIMULATION_ENABLED).toBe(false);
    expect(defaults.FISCALIZATION_SIMULATED_SEQUENCE).toBe("device_then_etims");
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        FISCALIZATION_SIMULATION_ENABLED: "true",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        NODE_ENV: "production",
        FISCALIZATION_SIMULATION_ENABLED: "true",
        ETIMS_PAYLOAD_ENCRYPTION_KEY: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        FISCALIZATION_SIMULATION_ENABLED: "true",
        ETIMS_PAYLOAD_ENCRYPTION_KEY: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("uses a loopback bind address by default", () => {
    const parsed = envSchema.parse(validEnvironment);
    expect(parsed.HOST).toBe("127.0.0.1");
    expect(parsed.API_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(parsed.API_RATE_LIMIT_MAX_REQUESTS).toBe(120);
  });

  it("accepts valid development and production configurations with optional providers disabled", () => {
    expect(parseEnvironment(validEnvironment).NODE_ENV).toBe("development");

    const production = parseEnvironment({
      ...validEnvironment,
      NODE_ENV: "production",
      INVOICE_API_BEARER_TOKEN: "i".repeat(48),
      OPERATOR_API_BEARER_TOKEN: "o".repeat(48),
      TREMOL_ADAPTER: "disabled",
      ETIMS_REPORTING_ENABLED: "false",
      ZOHO_SYNC_ENABLED: "false",
    });
    expect(production.NODE_ENV).toBe("production");
    expect(production.TREMOL_ADAPTER).toBe("disabled");
    expect(production.ETIMS_ADAPTER).toBeUndefined();
    expect(production.ZOHO_CLIENT_SECRET).toBeUndefined();
  });

  it("accepts named operator credentials and rejects malformed or conflicting settings", () => {
    const operators = JSON.stringify([
      {
        subject: "reconciliation-operator-1",
        token: "operator-token-that-is-long-enough-for-production",
        permissions: ["invoice:read", "manual-review:decide", "etims:reconcile"],
      },
    ]);
    const productionNamed = parseEnvironment({
      ...validEnvironment,
      NODE_ENV: "production",
      INVOICE_API_BEARER_TOKEN: "invoice-token-that-is-long-enough-for-production",
      OPERATOR_API_CREDENTIALS_JSON: operators,
    });
    expect(productionNamed.OPERATOR_API_CREDENTIALS_JSON).toBe(operators);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        OPERATOR_API_CREDENTIALS_JSON: "not-json",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        OPERATOR_API_CREDENTIALS_JSON: JSON.stringify([
          { ...JSON.parse(operators)[0], permissions: ["root:everything"] },
        ]),
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        OPERATOR_API_BEARER_TOKEN: "legacy-operator-token-long-enough-for-prod",
        OPERATOR_API_CREDENTIALS_JSON: operators,
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        INVOICE_API_BEARER_TOKEN: "operator-token-that-is-long-enough-for-production",
        OPERATOR_API_CREDENTIALS_JSON: operators,
      }).success,
    ).toBe(false);
  });

  it("fails fast with actionable configuration names and no supplied secret values", () => {
    const sentinel = "do-not-print-this-secret-value";
    let thrown: unknown;
    try {
      parseEnvironment({
        ...validEnvironment,
        NODE_ENV: "production",
        INVOICE_API_BEARER_TOKEN: sentinel,
        OPERATOR_API_BEARER_TOKEN: "o".repeat(48),
        DATABASE_URL: sentinel,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvironmentConfigurationError);
    expect(String(thrown)).toContain("DATABASE_URL");
    expect(String(thrown)).not.toContain(sentinel);
  });

  it("uses bounded database connection and command timeout defaults", () => {
    const parsed = envSchema.parse(validEnvironment);
    expect(parsed.POSTGRES_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(parsed.POSTGRES_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(parsed.DATABASE_PROVIDER).toBe("postgresql");
  });

  it("validates bounded health and graceful-shutdown deadlines", () => {
    const defaults = envSchema.parse(validEnvironment);
    expect(defaults.DEPENDENCY_HEALTH_TIMEOUT_MS).toBe(2_000);
    expect(defaults.SHUTDOWN_TIMEOUT_MS).toBe(30_000);
    expect(
      envSchema.safeParse({ ...validEnvironment, DEPENDENCY_HEALTH_TIMEOUT_MS: "99" }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ ...validEnvironment, SHUTDOWN_TIMEOUT_MS: "999" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({ ...validEnvironment, SHUTDOWN_TIMEOUT_MS: "120001" }).success,
    ).toBe(false);
  });

  it("keeps Tremol communication unselected unless the documented read-only mode is explicit", () => {
    const defaults = envSchema.parse(validEnvironment);
    expect(defaults.TREMOL_ADAPTER).toBe("disabled");
    expect(defaults.TREMOL_TRANSPORT).toBe("http");
    expect(defaults.TREMOL_TIMEOUT_MS).toBe(5_000);

    expect(
      envSchema.safeParse({ ...validEnvironment, TREMOL_ADAPTER: "simulator-fallback" }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ ...validEnvironment, TREMOL_TRANSPORT: "serial" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        TREMOL_ADAPTER: "zfplabserver_readonly",
        NODE_ENV: "production",
        TREMOL_BASE_URL: "http://192.0.2.12:4444",
      }).success,
    ).toBe(false);

    const readOnlyProduction = envSchema.parse({
      ...validEnvironment,
      NODE_ENV: "production",
      INVOICE_API_BEARER_TOKEN: "i".repeat(32),
      OPERATOR_API_BEARER_TOKEN: "o".repeat(32),
      TREMOL_ADAPTER: "zfplabserver_readonly",
      TREMOL_BASE_URL: "https://device.example.invalid",
    });
    expect(readOnlyProduction.TREMOL_ADAPTER).toBe("zfplabserver_readonly");
    expect(readOnlyProduction.FISCALIZATION_SIMULATION_ENABLED).toBe(false);
  });

  it.each([
    ["POSTGRES_CONNECT_TIMEOUT_MS", "99"],
    ["POSTGRES_CONNECT_TIMEOUT_MS", "120001"],
    ["POSTGRES_STATEMENT_TIMEOUT_MS", "0"],
    ["POSTGRES_STATEMENT_TIMEOUT_MS", "120001"],
    ["POSTGRES_CONNECT_TIMEOUT_MS", "1.5"],
  ] as const)("rejects invalid database timeout %s=%s", (setting, value) => {
    expect(envSchema.safeParse({ ...validEnvironment, [setting]: value }).success).toBe(false);
  });

  it("bounds API rate-limit configuration", () => {
    expect(
      envSchema.safeParse({ ...validEnvironment, API_RATE_LIMIT_MAX_REQUESTS: "0" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...validEnvironment, API_RATE_LIMIT_WINDOW_MS: "1" }).success,
    ).toBe(false);
  });

  it("disables scheduled Zoho synchronization by default and bounds its interval", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.ZOHO_SYNC_ENABLED).toBe(false);
    expect(result.ZOHO_SYNC_INTERVAL_MS).toBe(900_000);
    expect(result.ZOHO_SYNC_PAGE_SIZE).toBe(200);
    expect(result.ZOHO_SYNC_MAX_PAGES).toBe(1_000);
    expect(
      envSchema.safeParse({ ...validEnvironment, ZOHO_SYNC_INTERVAL_MS: "1000" }).success,
    ).toBe(false);
    expect(envSchema.safeParse({ ...validEnvironment, ZOHO_SYNC_PAGE_SIZE: "201" }).success).toBe(
      false,
    );
    expect(envSchema.safeParse({ ...validEnvironment, ZOHO_SYNC_MAX_PAGES: "1001" }).success).toBe(
      false,
    );
    expect(
      envSchema.safeParse({ ...validEnvironment, ZOHO_ORGANIZATION_ID: "bad/organization" })
        .success,
    ).toBe(false);
  });

  it("validates explicit Zoho invoice writeback field configuration", () => {
    const validFields = JSON.stringify({
      statusFieldId: "460000000099001",
      successStatusValue: "Fiscalized",
      deviceReceiptNumberFieldId: "460000000099002",
      etimsReferenceFieldId: "460000000099003",
      fiscalizedAtFieldId: "460000000099004",
      requestIdFieldId: "460000000099005",
    });
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: validFields,
        ZOHO_CLIENT_ID: "client-id",
        ZOHO_CLIENT_SECRET: "client-secret",
        ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
        ZOHO_ORGANIZATION_ID: "123456789",
      }).success,
    ).toBe(true);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: "not-json",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: JSON.stringify({
          statusFieldId: "invented",
          successStatusValue: "Fiscalized",
          requestIdFieldId: "invented",
        }),
      }).success,
    ).toBe(false);
  });

  it("requires usable Zoho OAuth and organization configuration when writeback fields are set", () => {
    const writeback = JSON.stringify({
      statusFieldId: "460000000099001",
      successStatusValue: "Done",
    });
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: writeback,
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: writeback,
        ZOHO_CLIENT_ID: "client-id",
        ZOHO_CLIENT_SECRET: "client-secret",
        ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
        ZOHO_ORGANIZATION_ID: "123456789",
      }).success,
    ).toBe(true);
  });

  it("disables eTIMS reporting by default and does not select a provider implicitly", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.ETIMS_REPORTING_ENABLED).toBe(false);
    expect(result.ETIMS_RECONCILIATION_ENABLED).toBe(false);
    expect(result.ETIMS_ADAPTER).toBeUndefined();
    expect(result.ETIMS_RECONCILIATION_INTERVAL_MS).toBe(300_000);
    expect(result.ETIMS_RECONCILIATION_BATCH_SIZE).toBe(10);
    expect(result.ETIMS_RECONCILIATION_MAX_ATTEMPTS).toBe(5);
    expect(result.ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS).toBe(15_000);
    expect(result.ETIMS_RECONCILIATION_MAX_RUNTIME_MS).toBe(120_000);
    expect(result.ETIMS_RECONCILIATION_STALE_AGE_MS).toBe(1_800_000);
  });

  it.each([
    ["ETIMS_RECONCILIATION_INTERVAL_MS", "9999"],
    ["ETIMS_RECONCILIATION_BATCH_SIZE", "101"],
    ["ETIMS_RECONCILIATION_MAX_ATTEMPTS", "21"],
    ["ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS", "120001"],
    ["ETIMS_RECONCILIATION_MAX_RUNTIME_MS", "1800001"],
    ["ETIMS_RECONCILIATION_STALE_AGE_MS", "29999"],
  ] as const)("rejects unsafe eTIMS worker configuration %s=%s", (setting, value) => {
    expect(envSchema.safeParse({ ...validEnvironment, [setting]: value }).success).toBe(false);
  });

  it.each(["vscu", "oscu"] as const)("accepts explicit eTIMS model selection: %s", (adapter) => {
    const result = envSchema.parse({
      ...validEnvironment,
      ETIMS_REPORTING_ENABLED: "true",
      ETIMS_ADAPTER: adapter,
      ...(adapter === "oscu"
        ? { ETIMS_OSCU_ENVIRONMENT: "sandbox" }
        : { ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088" }),
      ETIMS_PAYLOAD_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(result.ETIMS_REPORTING_ENABLED).toBe(true);
    expect(result.ETIMS_ADAPTER).toBe(adapter);
  });

  it("requires explicit reporting and payload encryption before enabling reconciliation", () => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ETIMS_RECONCILIATION_ENABLED: "true",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ETIMS_REPORTING_ENABLED: "true",
        ETIMS_RECONCILIATION_ENABLED: "true",
        ETIMS_ADAPTER: "vscu",
        ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088",
        ETIMS_PAYLOAD_ENCRYPTION_KEY: "a".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("validates a versioned payload keyring without exposing key material", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ETIMS_REPORTING_ENABLED: "true",
      ETIMS_ADAPTER: "vscu",
      ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088",
      ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON: JSON.stringify({
        "legacy-v1": "a".repeat(64),
        "rotation-2": "b".repeat(64),
      }),
      ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID: "rotation-2",
    });
    expect(result.success).toBe(true);

    const missingActive = envSchema.safeParse({
      ...validEnvironment,
      ETIMS_REPORTING_ENABLED: "true",
      ETIMS_ADAPTER: "vscu",
      ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088",
      ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON: JSON.stringify({ old: "a".repeat(64) }),
      ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID: "new",
    });
    expect(missingActive.success).toBe(false);
    expect(JSON.stringify(missingActive.error?.issues)).not.toContain("a".repeat(64));
  });

  it("rejects unrecognized eTIMS model selections", () => {
    expect(envSchema.safeParse({ ...validEnvironment, ETIMS_ADAPTER: "automatic" }).success).toBe(
      false,
    );
  });

  it("requires enabled reporting to have one selected and independently configured adapter", () => {
    const base = {
      ...validEnvironment,
      ETIMS_REPORTING_ENABLED: "true",
      ETIMS_PAYLOAD_ENCRYPTION_KEY: "a".repeat(64),
    };
    expect(envSchema.safeParse(base).success).toBe(false);
    expect(envSchema.safeParse({ ...base, ETIMS_ADAPTER: "oscu" }).success).toBe(false);
    expect(
      envSchema.safeParse({
        ...base,
        ETIMS_ADAPTER: "oscu",
        ETIMS_OSCU_ENVIRONMENT: "sandbox",
        ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088",
      }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...base,
        ETIMS_ADAPTER: "vscu",
        ETIMS_VSCU_BASE_URL: "http://127.0.0.1:8088",
        ETIMS_OSCU_ENVIRONMENT: "sandbox",
      }).success,
    ).toBe(false);
    expect(envSchema.safeParse(validEnvironment).success).toBe(true);
  });

  it("keeps OSCU environment and VSCU service URL explicit and validates their transport fields", () => {
    const defaults = envSchema.parse(validEnvironment);
    expect(defaults.ETIMS_OSCU_ENVIRONMENT).toBeUndefined();
    expect(defaults.ETIMS_VSCU_BASE_URL).toBeUndefined();
    expect(defaults.ETIMS_PROVIDER_TIMEOUT_MS).toBe(15_000);
    expect(
      envSchema.safeParse({ ...validEnvironment, ETIMS_OSCU_ENVIRONMENT: "automatic" }).success,
    ).toBe(false);
    expect(
      envSchema.safeParse({ ...validEnvironment, ETIMS_VSCU_BASE_URL: "ftp://localhost:8088" })
        .success,
    ).toBe(false);
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ETIMS_VSCU_BASE_URL: "http://user:secret@localhost:8088",
      }).success,
    ).toBe(false);
  });

  it("rejects enabling eTIMS reporting in production while its contracts are unverified", () => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        NODE_ENV: "production",
        INVOICE_API_BEARER_TOKEN: "a".repeat(64),
        ETIMS_REPORTING_ENABLED: "true",
      }).success,
    ).toBe(false);
  });

  it("rejects Zoho synchronization without OAuth credentials and organization", () => {
    expect(envSchema.safeParse({ ...validEnvironment, ZOHO_SYNC_ENABLED: "true" }).success).toBe(
      false,
    );
  });

  it("enables scheduled Zoho synchronization only when explicitly configured", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      ZOHO_SYNC_ENABLED: "true",
      ZOHO_SYNC_INTERVAL_MS: "60000",
      ZOHO_CLIENT_ID: "client-id",
      ZOHO_CLIENT_SECRET: "client-secret",
      ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
      ZOHO_ORGANIZATION_ID: "organization-1",
    });

    expect(result.ZOHO_SYNC_ENABLED).toBe(true);
    expect(result.ZOHO_SYNC_INTERVAL_MS).toBe(60_000);
  });

  it("enables stale fiscalization recovery only when explicitly configured", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      FISCALIZATION_RECOVERY_ENABLED: "true",
    });

    expect(result.FISCALIZATION_RECOVERY_ENABLED).toBe(true);
  });

  it("accepts recovery explicitly disabled as a string", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      FISCALIZATION_RECOVERY_ENABLED: "false",
    });

    expect(result.FISCALIZATION_RECOVERY_ENABLED).toBe(false);
  });

  it("rejects an invalid recovery enabled value", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      FISCALIZATION_RECOVERY_ENABLED: "yes",
    });

    expect(result.success).toBe(false);
  });

  it.each(["FISCALIZATION_RECOVERY_INTERVAL_MS", "FISCALIZATION_RECOVERY_STALE_AGE_MS"] as const)(
    "rejects zero for %s",
    (setting) => {
      const result = envSchema.safeParse({
        ...validEnvironment,
        [setting]: "0",
      });

      expect(result.success).toBe(false);
    },
  );

  it.each(["FISCALIZATION_RECOVERY_INTERVAL_MS", "FISCALIZATION_RECOVERY_STALE_AGE_MS"] as const)(
    "rejects negative values for %s",
    (setting) => {
      const result = envSchema.safeParse({
        ...validEnvironment,
        [setting]: "-1000",
      });

      expect(result.success).toBe(false);
    },
  );

  it("accepts custom positive integer recovery timings", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      FISCALIZATION_RECOVERY_INTERVAL_MS: "60000",
      FISCALIZATION_RECOVERY_STALE_AGE_MS: "900000",
    });

    expect(result.FISCALIZATION_RECOVERY_INTERVAL_MS).toBe(60_000);
    expect(result.FISCALIZATION_RECOVERY_STALE_AGE_MS).toBe(900_000);
  });

  it("accepts a valid invoice API bearer token", () => {
    const token = "a".repeat(64);

    const result = envSchema.safeParse({
      ...validEnvironment,
      INVOICE_API_BEARER_TOKEN: token,
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.INVOICE_API_BEARER_TOKEN).toBe(token);
    }
  });

  it("rejects an invoice API bearer token shorter than 32 characters", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      INVOICE_API_BEARER_TOKEN: "a".repeat(31),
    });

    expect(result.success).toBe(false);
  });

  it("requires an invoice API bearer token in production", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      NODE_ENV: "production",
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["INVOICE_API_BEARER_TOKEN"],
          message: "INVOICE_API_BEARER_TOKEN is required in production",
        }),
      );
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["OPERATOR_API_CREDENTIALS_JSON"],
          message: "Operator authentication is required in production",
        }),
      );
    }
  });

  it.each(["development", "test"])(
    "allows the invoice API bearer token to be omitted in %s",
    (nodeEnv) => {
      const result = envSchema.safeParse({
        ...validEnvironment,
        NODE_ENV: nodeEnv,
      });

      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.data.INVOICE_API_BEARER_TOKEN).toBeUndefined();
      }
    },
  );

  it("applies defaults when optional Zoho credentials are omitted", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.ZOHO_CLIENT_ID).toBeUndefined();
    expect(result.ZOHO_CLIENT_SECRET).toBeUndefined();
    expect(result.ZOHO_ORGANIZATION_ID).toBeUndefined();
    expect(result.ZOHO_REDIRECT_URI).toBe("http://localhost:3000/integrations/zoho/callback");
    expect(result.ZOHO_ACCOUNTS_URL).toBe("https://accounts.zoho.com");
  });

  it("accepts both Zoho OAuth credentials", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      ZOHO_CLIENT_ID: "test-client-id",
      ZOHO_CLIENT_SECRET: "test-client-secret",
      ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(result.ZOHO_CLIENT_ID).toBe("test-client-id");
    expect(result.ZOHO_CLIENT_SECRET).toBe("test-client-secret");
  });

  it("accepts a Zoho Books organization ID", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      ZOHO_ORGANIZATION_ID: "123456789",
      ZOHO_CLIENT_ID: "test-client-id",
      ZOHO_CLIENT_SECRET: "test-client-secret",
      ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(result.ZOHO_ORGANIZATION_ID).toBe("123456789");
  });

  it.each(["", "   "])("rejects a blank Zoho Books organization ID: %j", (organizationId) => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_ORGANIZATION_ID: organizationId,
    });

    expect(result.success).toBe(false);
  });

  it("rejects a client ID without a client secret", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_CLIENT_ID: "test-client-id",
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["ZOHO_CLIENT_SECRET"],
          message: "ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be configured together",
        }),
      );
    }
  });

  it("rejects a client secret without a client ID", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_CLIENT_SECRET: "test-client-secret",
    });

    expect(result.success).toBe(false);

    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["ZOHO_CLIENT_ID"],
          message: "ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be configured together",
        }),
      );
    }
  });

  it.each(["", "   "])("rejects a blank client ID: %j", (clientId) => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_CLIENT_ID: clientId,
      ZOHO_CLIENT_SECRET: "test-client-secret",
    });

    expect(result.success).toBe(false);
  });

  it.each(["", "   "])("rejects a blank client secret: %j", (clientSecret) => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_CLIENT_ID: "test-client-id",
      ZOHO_CLIENT_SECRET: clientSecret,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid Zoho redirect URI", () => {
    const result = envSchema.safeParse({
      ...validEnvironment,
      ZOHO_REDIRECT_URI: "not-a-url",
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-Zoho and plaintext Accounts endpoints", () => {
    for (const accountsUrl of ["http://accounts.zoho.com", "https://attacker.example"]) {
      expect(
        envSchema.safeParse({ ...validEnvironment, ZOHO_ACCOUNTS_URL: accountsUrl }).success,
      ).toBe(false);
    }
  });

  it("accepts the documented UAE Zoho Accounts data center", () => {
    expect(
      envSchema.safeParse({ ...validEnvironment, ZOHO_ACCOUNTS_URL: "https://accounts.zoho.ae" })
        .success,
    ).toBe(true);
  });

  it("requires Zoho token encryption when OAuth credentials are configured", () => {
    expect(
      envSchema.safeParse({
        ...validEnvironment,
        ZOHO_CLIENT_ID: "client-id",
        ZOHO_CLIENT_SECRET: "client-secret",
      }).success,
    ).toBe(false);
  });

  it("rejects SQL Server because PostgreSQL is the supported persistence provider", () => {
    expect(
      envSchema.safeParse({
        DATABASE_PROVIDER: "sqlserver",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid 32-byte hexadecimal OAuth encryption key", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      ZOHO_OAUTH_ENCRYPTION_KEY: "a".repeat(64),
    });

    expect(result.ZOHO_OAUTH_ENCRYPTION_KEY).toBe("a".repeat(64));
  });

  it("allows the OAuth encryption key to be omitted during development", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.ZOHO_OAUTH_ENCRYPTION_KEY).toBeUndefined();
  });

  it.each(["", "not-a-key", "a".repeat(63), "g".repeat(64)])(
    "rejects an invalid OAuth encryption key: %j",
    (key) => {
      const result = envSchema.safeParse({
        ...validEnvironment,
        ZOHO_OAUTH_ENCRYPTION_KEY: key,
      });

      expect(result.success).toBe(false);
    },
  );
});
