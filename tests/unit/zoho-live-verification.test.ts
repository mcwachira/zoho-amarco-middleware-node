import { describe, expect, it } from "vitest";
import {
  inspectZohoInvoiceCustomFields,
  resolveZohoLiveVerificationDatabaseUrl,
  ZohoLiveVerificationIssue,
} from "../../src/integrations/zoho/live-verification.js";

describe("read-only Zoho custom-field inspection", () => {
  it("derives the dedicated database URL from a loopback application URL", () => {
    const result = resolveZohoLiveVerificationDatabaseUrl(
      undefined,
      "postgresql://local-user:local-password@localhost:5438/zoho_amarco_dev?sslmode=disable",
    );
    const parsed = new URL(result);
    expect(parsed.hostname).toBe("localhost");
    expect(parsed.port).toBe("5438");
    expect(parsed.pathname).toBe("/zoho_amarco_zoho_live_test");
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
  });

  it("does not derive a verification database URL from a non-loopback application URL", () => {
    expect(() =>
      resolveZohoLiveVerificationDatabaseUrl(
        undefined,
        "postgresql://local-user:local-password@database.example/zoho_amarco_dev",
      ),
    ).toThrowError(ZohoLiveVerificationIssue);
  });

  it("requires an explicitly supplied verifier URL to target the dedicated database", () => {
    expect(() =>
      resolveZohoLiveVerificationDatabaseUrl(
        "postgresql://local-user:local-password@localhost:5438/zoho_amarco_dev",
        "postgresql://local-user:local-password@localhost:5438/zoho_amarco_dev",
      ),
    ).toThrowError(ZohoLiveVerificationIssue);
  });

  it("allows the invoice response to omit custom fields when none are configured", () => {
    expect(inspectZohoInvoiceCustomFields({ invoice_id: "fixture-id" }, [])).toEqual({
      count: null,
      shape: "not_returned",
      configuredFields: "not_configured",
    });
  });

  it("validates returned custom-field shape without requiring a marker field", () => {
    expect(
      inspectZohoInvoiceCustomFields(
        {
          custom_fields: [{ customfield_id: "10001", value: "existing-value" }],
        },
        [],
      ),
    ).toEqual({ count: 1, shape: "valid", configuredFields: "not_configured" });
  });

  it("checks configured writeback fields if the organization has a mapping", () => {
    expect(
      inspectZohoInvoiceCustomFields(
        {
          custom_fields: [{ customfield_id: 10001, value: "status" }],
        },
        ["10001"],
      ),
    ).toEqual({ count: 1, shape: "valid", configuredFields: "present" });
  });

  it("reports a missing configured field as validation, without fabricating a value", () => {
    expect(() => inspectZohoInvoiceCustomFields({ custom_fields: [] }, ["10001"])).toThrowError(
      ZohoLiveVerificationIssue,
    );
  });

  it("rejects malformed custom-field payloads without exposing their contents", () => {
    expect(() =>
      inspectZohoInvoiceCustomFields({ custom_fields: [{ customfield_id: "10001" }] }, []),
    ).toThrowError(ZohoLiveVerificationIssue);
  });
});
