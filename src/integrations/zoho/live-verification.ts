export type ZohoLiveVerificationCategory = "validation" | "malformed_response";

export class ZohoLiveVerificationIssue extends Error {
  constructor(
    readonly category: ZohoLiveVerificationCategory,
    message: string,
  ) {
    super(message);
    this.name = "ZohoLiveVerificationIssue";
  }
}

export interface ZohoInvoiceCustomFieldInspection {
  readonly count: number | null;
  readonly shape: "valid" | "not_returned";
  readonly configuredFields: "present" | "not_configured";
}

const LIVE_VERIFICATION_DATABASE = "zoho_amarco_zoho_live_test";

/**
 * Uses an explicit dedicated URL when supplied, or derives the same dedicated
 * database URL from a loopback PostgreSQL application URL. The fallback never
 * points at the application's database.
 */
export function resolveZohoLiveVerificationDatabaseUrl(
  explicitUrl: string | undefined,
  applicationDatabaseUrl: string | undefined,
): string {
  if (explicitUrl?.trim()) {
    const parsed = parsePostgresqlUrl(explicitUrl.trim());
    if (parsed.pathname.slice(1) !== LIVE_VERIFICATION_DATABASE) {
      throw new ZohoLiveVerificationIssue(
        "validation",
        "ZOHO_LIVE_VERIFY_DATABASE_URL must target the dedicated Zoho verification database.",
      );
    }
    return parsed.toString();
  }

  if (!applicationDatabaseUrl?.trim()) {
    throw new ZohoLiveVerificationIssue(
      "validation",
      "Set ZOHO_LIVE_VERIFY_DATABASE_URL or configure a local PostgreSQL DATABASE_URL from which the dedicated URL can be derived.",
    );
  }

  const parsed = parsePostgresqlUrl(applicationDatabaseUrl.trim());
  if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new ZohoLiveVerificationIssue(
      "validation",
      "A dedicated verifier database URL is required when DATABASE_URL does not use loopback.",
    );
  }
  parsed.pathname = `/${LIVE_VERIFICATION_DATABASE}`;
  return parsed.toString();
}

/**
 * Checks only response structure and configured field presence. It does not
 * infer invoice safety or treat operator confirmation as tenant verification.
 */
export function inspectZohoInvoiceCustomFields(
  invoiceSource: Readonly<Record<string, unknown>>,
  configuredFieldIds: readonly string[],
): ZohoInvoiceCustomFieldInspection {
  const rawFields = invoiceSource["custom_fields"];
  if (rawFields === undefined) {
    if (configuredFieldIds.length > 0) {
      throw new ZohoLiveVerificationIssue(
        "validation",
        "Configured Zoho custom fields were not returned for the invoice.",
      );
    }
    return { count: null, shape: "not_returned", configuredFields: "not_configured" };
  }
  if (!Array.isArray(rawFields)) {
    throw new ZohoLiveVerificationIssue(
      "malformed_response",
      "Zoho invoice custom-field response shape is invalid.",
    );
  }

  const fields = rawFields.map((value) => {
    if (!isRecord(value)) {
      throw new ZohoLiveVerificationIssue(
        "malformed_response",
        "Zoho invoice custom-field response shape is invalid.",
      );
    }
    const id = value["customfield_id"];
    if (
      (typeof id !== "string" && typeof id !== "number") ||
      String(id).trim() === "" ||
      !("value" in value)
    ) {
      throw new ZohoLiveVerificationIssue(
        "malformed_response",
        "Zoho invoice custom-field response shape is invalid.",
      );
    }
    return { id: String(id), value: value["value"], hasValue: "value" in value };
  });

  for (const fieldId of configuredFieldIds) {
    const field = fields.find((candidate) => candidate.id === fieldId);
    if (!field || !field.hasValue || (typeof field.value !== "string" && field.value !== null)) {
      throw new ZohoLiveVerificationIssue(
        "validation",
        "A configured Zoho custom field is missing or has an unsupported value shape.",
      );
    }
  }

  return {
    count: fields.length,
    shape: "valid",
    configuredFields: configuredFieldIds.length > 0 ? "present" : "not_configured",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePostgresqlUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ZohoLiveVerificationIssue(
      "validation",
      "The Zoho verification database URL must be a valid PostgreSQL URL.",
    );
  }
  if (
    (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") ||
    !parsed.pathname.slice(1)
  ) {
    throw new ZohoLiveVerificationIssue(
      "validation",
      "The Zoho verification database URL must include a PostgreSQL database name.",
    );
  }
  return parsed;
}
