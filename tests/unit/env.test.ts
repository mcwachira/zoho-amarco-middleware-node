import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/env.js";

describe("Environment configuration", () => {
  // Use a valid baseline so each test focuses on the setting being checked.
  const validEnvironment = {
    DATABASE_PROVIDER: "postgresql",
    DATABASE_URL: "postgresql://test:test@localhost:5432/zoho_amarco_test",
  };

  it("disables stale fiscalization recovery by default", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.FISCALIZATION_RECOVERY_ENABLED).toBe(false);
    expect(result.FISCALIZATION_RECOVERY_INTERVAL_MS).toBe(300_000);
    expect(result.FISCALIZATION_RECOVERY_STALE_AGE_MS).toBe(1_800_000);
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
    });

    expect(result.ZOHO_CLIENT_ID).toBe("test-client-id");
    expect(result.ZOHO_CLIENT_SECRET).toBe("test-client-secret");
  });

  it("accepts a Zoho Books organization ID", () => {
    const result = envSchema.parse({
      ...validEnvironment,
      ZOHO_ORGANIZATION_ID: "123456789",
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
