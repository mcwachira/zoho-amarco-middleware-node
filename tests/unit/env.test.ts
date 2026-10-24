import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/config/env.js";

describe("Environment configuration", () => {
  // Use a valid baseline so each test focuses on the setting being checked.
  const validEnvironment = {
    DATABASE_PROVIDER: "postgresql",
    DATABASE_URL: "postgresql://test:test@localhost:5432/zoho_amarco_test",
  };

  it("applies defaults when optional Zoho credentials are omitted", () => {
    const result = envSchema.parse(validEnvironment);

    expect(result.ZOHO_CLIENT_ID).toBeUndefined();
    expect(result.ZOHO_CLIENT_SECRET).toBeUndefined();
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
});
