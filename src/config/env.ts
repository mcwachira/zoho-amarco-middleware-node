import "dotenv/config";
import { z } from "zod";
import { parseZohoFiscalizationWritebackConfiguration } from "../application/zoho/zoho-fiscalization-writeback-config.js";
import { parseZohoAccountsDomain } from "../integrations/zoho/accounts-domain.js";
import { parseNamedOperatorCredentials } from "./operator-api-credentials.js";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_PROVIDER: z.enum(["postgresql"]).default("postgresql"),
    DATABASE_URL: z.string().optional(),
    POSTGRES_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
    POSTGRES_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(30_000),

    // Protect invoice endpoints from unauthorized access.
    // Generate a strong random token and keep it out of source control.
    INVOICE_API_BEARER_TOKEN: z.string().trim().min(32).optional(),
    // Separate high-privilege token for device, eTIMS reconciliation, and profile administration.
    OPERATOR_API_BEARER_TOKEN: z.string().trim().min(32).optional(),
    // Optional per-operator bearer credentials with named subjects and explicit permissions.
    OPERATOR_API_CREDENTIALS_JSON: z.string().optional(),
    // Tremol ZFPLabServer connection.
    // The device endpoint is not contacted unless the read-only adapter is selected.
    TREMOL_ADAPTER: z.enum(["disabled", "zfplabserver_readonly"]).default("disabled"),
    TREMOL_TRANSPORT: z.enum(["http"]).default("http"),
    TREMOL_BASE_URL: z.string().url().default("http://127.0.0.1:4444"),
    TREMOL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(5_000),
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    API_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).max(100_000).default(120),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DEPENDENCY_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
    // Stale fiscalization recovery is opt-in and disabled by default.
    // Environment variables are strings, so do not use z.coerce.boolean():
    // the string "false" would otherwise be interpreted as true.
    FISCALIZATION_RECOVERY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),

    // Provisional defaults: review before enabling in production.
    FISCALIZATION_RECOVERY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60 * 1000),

    FISCALIZATION_RECOVERY_STALE_AGE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    FISCALIZATION_SIMULATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    FISCALIZATION_SIMULATED_DEVICE_SCENARIO: z
      .enum(["success", "failure", "timeout", "uncertain", "exception", "unavailable"])
      .default("success"),
    FISCALIZATION_SIMULATED_ETIMS_SCENARIO: z
      .enum(["accepted", "rejected", "timeout", "uncertain", "exception", "unavailable"])
      .default("accepted"),
    FISCALIZATION_SIMULATED_SEQUENCE: z
      .enum(["device_then_etims", "etims_then_device"])
      .default("device_then_etims"),

    // Zoho Books OAuth credentials remain optional during development.
    // If provided, each credential must contain a non-whitespace value.
    ZOHO_CLIENT_ID: z.string().trim().min(1).optional(),
    ZOHO_CLIENT_SECRET: z.string().trim().min(1).optional(),
    ZOHO_ORGANIZATION_ID: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
      .optional(),
    ZOHO_SYNC_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ZOHO_SYNC_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
    ZOHO_SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(200),
    ZOHO_SYNC_MAX_PAGES: z.coerce.number().int().min(1).max(1_000).default(1_000),
    ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON: z.string().optional(),
    // Explicit provider selection only; neither option enables an unverified adapter.
    ETIMS_REPORTING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ETIMS_RECONCILIATION_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ETIMS_PAYLOAD_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "Must be a 64-character hexadecimal key")
      .optional(),
    // A keyring is supplied by the deployment secret manager as JSON. It is
    // intentionally never logged; old IDs must remain present during rotation.
    ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON: z.string().optional(),
    ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .default("legacy-v1"),
    ETIMS_PAYLOAD_ENCRYPTION_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,100}$/)
      .default("legacy-v1"),
    ETIMS_ADAPTER: z.enum(["vscu", "oscu"]).optional(),
    ETIMS_OSCU_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
    ETIMS_VSCU_BASE_URL: z.string().url().optional(),
    ETIMS_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
    ETIMS_RECONCILIATION_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(86_400_000)
      .default(300_000),
    ETIMS_RECONCILIATION_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    ETIMS_RECONCILIATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    ETIMS_RECONCILIATION_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(120_000)
      .default(15_000),
    ETIMS_RECONCILIATION_MAX_RUNTIME_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(1_800_000)
      .default(120_000),
    ETIMS_RECONCILIATION_STALE_AGE_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(86_400_000)
      .default(1_800_000),

    // Must exactly match the redirect URI registered in Zoho API Console.
    ZOHO_REDIRECT_URI: z.string().url().default("http://localhost:3000/integrations/zoho/callback"),

    // Default to the US data center; configure the correct region for your account.
    ZOHO_ACCOUNTS_URL: z.string().url().default("https://accounts.zoho.com"), // A 32-byte (64-character hexadecimal) key used to encrypt PKCE verifiers.
    // Keep it out of source control and never log it.
    ZOHO_OAUTH_ENCRYPTION_KEY: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, "Must be a 64-character hexadecimal key")
      .optional(),
  })
  .superRefine((value, context) => {
    let namedOperatorCredentials: ReturnType<typeof parseNamedOperatorCredentials> = [];
    if (value.OPERATOR_API_CREDENTIALS_JSON !== undefined) {
      try {
        namedOperatorCredentials = parseNamedOperatorCredentials(
          value.OPERATOR_API_CREDENTIALS_JSON,
        );
      } catch {
        context.addIssue({
          code: "custom",
          path: ["OPERATOR_API_CREDENTIALS_JSON"],
          message: "Operator credential configuration is invalid.",
        });
      }
    }
    if (value.OPERATOR_API_BEARER_TOKEN && value.OPERATOR_API_CREDENTIALS_JSON !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_API_CREDENTIALS_JSON"],
        message: "Use either the legacy operator token or named operator credentials, not both.",
      });
    }
    if (
      value.INVOICE_API_BEARER_TOKEN &&
      namedOperatorCredentials.some(
        (credential) => credential.token === value.INVOICE_API_BEARER_TOKEN,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_API_CREDENTIALS_JSON"],
        message: "Operator and service API tokens must be different.",
      });
    }
    if (value.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON !== undefined) {
      try {
        parseZohoFiscalizationWritebackConfiguration(
          value.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON,
        );
      } catch {
        context.addIssue({
          code: "custom",
          path: ["ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON"],
          message: "Zoho fiscalization writeback field configuration is invalid.",
        });
      }
    }
    if (value.DATABASE_PROVIDER === "postgresql" && !value.DATABASE_URL?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when DATABASE_PROVIDER is postgresql",
      });
    }

    if (value.DATABASE_PROVIDER === "postgresql" && value.DATABASE_URL?.trim()) {
      try {
        const databaseUrl = new URL(value.DATABASE_URL);
        if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
          throw new Error("invalid protocol");
        }
        if (databaseUrl.username === "" || databaseUrl.pathname.length < 2) {
          throw new Error("missing database identity");
        }
      } catch {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "DATABASE_URL must be a PostgreSQL URL with a database name",
        });
      }
    }

    let tremolUrl: URL | undefined;
    try {
      tremolUrl = new URL(value.TREMOL_BASE_URL);
    } catch {
      // The URL schema reports malformed values. Keep refinement diagnostics safe.
    }
    if (
      tremolUrl &&
      ((tremolUrl.protocol !== "http:" && tremolUrl.protocol !== "https:") ||
        tremolUrl.username !== "" ||
        tremolUrl.password !== "" ||
        tremolUrl.search !== "" ||
        tremolUrl.hash !== "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["TREMOL_BASE_URL"],
        message: "TREMOL_BASE_URL must be an HTTP(S) origin without credentials or query data",
      });
    }

    if (value.ETIMS_VSCU_BASE_URL) {
      let vscuUrl: URL | undefined;
      try {
        vscuUrl = new URL(value.ETIMS_VSCU_BASE_URL);
      } catch {
        // The URL schema reports malformed values.
      }
      if (
        vscuUrl &&
        ((vscuUrl.protocol !== "http:" && vscuUrl.protocol !== "https:") ||
          vscuUrl.username !== "" ||
          vscuUrl.password !== "" ||
          vscuUrl.search !== "" ||
          vscuUrl.hash !== "")
      ) {
        context.addIssue({
          code: "custom",
          path: ["ETIMS_VSCU_BASE_URL"],
          message:
            "ETIMS_VSCU_BASE_URL must be an HTTP(S) service URL without credentials or query data",
        });
      }
    }
    if (value.ETIMS_REPORTING_ENABLED) {
      if (!value.ETIMS_ADAPTER) {
        context.addIssue({
          code: "custom",
          path: ["ETIMS_ADAPTER"],
          message: "Select an OSCU or VSCU adapter when eTIMS reporting is enabled",
        });
      } else if (value.ETIMS_ADAPTER === "oscu") {
        if (!value.ETIMS_OSCU_ENVIRONMENT) {
          context.addIssue({
            code: "custom",
            path: ["ETIMS_OSCU_ENVIRONMENT"],
            message: "ETIMS_OSCU_ENVIRONMENT is required for enabled OSCU reporting",
          });
        }
        if (value.ETIMS_VSCU_BASE_URL) {
          context.addIssue({
            code: "custom",
            path: ["ETIMS_VSCU_BASE_URL"],
            message: "VSCU service configuration cannot be combined with enabled OSCU reporting",
          });
        }
      } else {
        if (!value.ETIMS_VSCU_BASE_URL) {
          context.addIssue({
            code: "custom",
            path: ["ETIMS_VSCU_BASE_URL"],
            message: "ETIMS_VSCU_BASE_URL is required for enabled VSCU reporting",
          });
        }
        if (value.ETIMS_OSCU_ENVIRONMENT) {
          context.addIssue({
            code: "custom",
            path: ["ETIMS_OSCU_ENVIRONMENT"],
            message: "OSCU environment cannot be combined with enabled VSCU reporting",
          });
        }
      }
    }
    if (
      value.NODE_ENV === "production" &&
      tremolUrl?.protocol === "http:" &&
      !["localhost", "127.0.0.1", "::1"].includes(tremolUrl.hostname)
    ) {
      context.addIssue({
        code: "custom",
        path: ["TREMOL_BASE_URL"],
        message: "A non-local Tremol endpoint must use HTTPS in production",
      });
    }

    let accountsUrl: URL | undefined;
    try {
      accountsUrl = new URL(value.ZOHO_ACCOUNTS_URL);
    } catch {
      // The URL schema reports malformed values.
    }
    if (accountsUrl && parseZohoAccountsDomain(value.ZOHO_ACCOUNTS_URL) === null) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_ACCOUNTS_URL"],
        message: "ZOHO_ACCOUNTS_URL must use a supported HTTPS Zoho Accounts origin",
      });
    }

    let redirectUrl: URL | undefined;
    try {
      redirectUrl = new URL(value.ZOHO_REDIRECT_URI);
    } catch {
      // The URL schema reports malformed values.
    }
    if (
      value.NODE_ENV === "production" &&
      redirectUrl?.protocol !== "https:" &&
      !(
        redirectUrl?.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(redirectUrl.hostname)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_REDIRECT_URI"],
        message: "Production OAuth redirect URIs must use HTTPS except for loopback testing",
      });
    }

    if (value.NODE_ENV === "production" && !value.INVOICE_API_BEARER_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["INVOICE_API_BEARER_TOKEN"],
        message: "INVOICE_API_BEARER_TOKEN is required in production",
      });
    }
    if (
      value.NODE_ENV === "production" &&
      !value.OPERATOR_API_BEARER_TOKEN &&
      value.OPERATOR_API_CREDENTIALS_JSON === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_API_CREDENTIALS_JSON"],
        message: "Operator authentication is required in production",
      });
    }
    if (
      value.INVOICE_API_BEARER_TOKEN &&
      value.OPERATOR_API_BEARER_TOKEN &&
      value.INVOICE_API_BEARER_TOKEN === value.OPERATOR_API_BEARER_TOKEN
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_API_BEARER_TOKEN"],
        message: "Operator and service API tokens must be different",
      });
    }
    if (
      value.INVOICE_API_BEARER_TOKEN &&
      namedOperatorCredentials.some(
        (credential) => credential.token === value.INVOICE_API_BEARER_TOKEN,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_API_CREDENTIALS_JSON"],
        message: "Operator and service API tokens must be different",
      });
    }

    // OAuth must have both credentials or neither.
    const hasClientId = Boolean(value.ZOHO_CLIENT_ID);
    const hasClientSecret = Boolean(value.ZOHO_CLIENT_SECRET);

    if (hasClientId !== hasClientSecret) {
      context.addIssue({
        code: "custom",
        path: [hasClientId ? "ZOHO_CLIENT_SECRET" : "ZOHO_CLIENT_ID"],
        message: "ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be configured together",
      });
    }

    if ((hasClientId || hasClientSecret) && !value.ZOHO_OAUTH_ENCRYPTION_KEY) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_OAUTH_ENCRYPTION_KEY"],
        message: "ZOHO_OAUTH_ENCRYPTION_KEY is required when Zoho OAuth credentials are configured",
      });
    }
    if (value.ZOHO_ORGANIZATION_ID && !hasClientId) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_ORGANIZATION_ID"],
        message: "Zoho organization configuration requires OAuth credentials and encryption key",
      });
    }
    if (value.ZOHO_SYNC_ENABLED && (!hasClientId || !value.ZOHO_ORGANIZATION_ID)) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_SYNC_ENABLED"],
        message: "Zoho synchronization requires OAuth credentials and organization ID",
      });
    }
    if (
      value.ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON !== undefined &&
      (!hasClientId || !value.ZOHO_ORGANIZATION_ID)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ZOHO_FISCALIZATION_WRITEBACK_FIELDS_JSON"],
        message:
          "Zoho fiscalization writeback field configuration requires OAuth credentials and organization ID",
      });
    }
    if (value.NODE_ENV === "production" && value.ETIMS_REPORTING_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["ETIMS_REPORTING_ENABLED"],
        message:
          "Production eTIMS reporting is blocked until provider and legal contracts are verified",
      });
    }
    if (value.FISCALIZATION_SIMULATION_ENABLED && value.NODE_ENV === "production") {
      context.addIssue({
        code: "custom",
        path: ["FISCALIZATION_SIMULATION_ENABLED"],
        message: "Fiscalization simulation is forbidden in production",
      });
    }
    if (
      value.FISCALIZATION_SIMULATION_ENABLED &&
      !value.ETIMS_PAYLOAD_ENCRYPTION_KEY &&
      !value.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON
    ) {
      context.addIssue({
        code: "custom",
        path: ["ETIMS_PAYLOAD_ENCRYPTION_KEY"],
        message: "Simulation requires an eTIMS payload encryption key or keyring",
      });
    }
    if (value.ETIMS_RECONCILIATION_ENABLED && !value.ETIMS_REPORTING_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["ETIMS_RECONCILIATION_ENABLED"],
        message: "eTIMS reconciliation requires ETIMS_REPORTING_ENABLED=true",
      });
    }
    if (value.ETIMS_RECONCILIATION_ENABLED && !value.ETIMS_ADAPTER) {
      context.addIssue({
        code: "custom",
        path: ["ETIMS_ADAPTER"],
        message: "eTIMS reconciliation requires an explicit adapter selection",
      });
    }
    let validPayloadKeyring = false;
    if (value.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON) {
      try {
        const parsed: unknown = JSON.parse(value.ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length > 0 &&
          Object.entries(parsed).every(
            ([keyId, key]) =>
              /^[A-Za-z0-9._-]{1,100}$/.test(keyId) &&
              typeof key === "string" &&
              /^[0-9a-fA-F]{64}$/.test(key),
          ) &&
          Object.hasOwn(parsed, value.ETIMS_PAYLOAD_ENCRYPTION_ACTIVE_KEY_ID)
        ) {
          validPayloadKeyring = true;
        }
      } catch {
        // Report a generic issue below without including the keyring value.
      }
      if (!validPayloadKeyring || value.ETIMS_PAYLOAD_ENCRYPTION_KEY) {
        context.addIssue({
          code: "custom",
          path: ["ETIMS_PAYLOAD_ENCRYPTION_KEYRING_JSON"],
          message:
            "Payload keyring must be valid JSON containing the active key and cannot be combined with the legacy single key",
        });
      }
    }
    if (
      value.ETIMS_REPORTING_ENABLED &&
      !value.ETIMS_PAYLOAD_ENCRYPTION_KEY &&
      !validPayloadKeyring
    ) {
      context.addIssue({
        code: "custom",
        path: ["ETIMS_PAYLOAD_ENCRYPTION_KEY"],
        message:
          "A valid payload encryption key or keyring is required when eTIMS reporting is enabled",
      });
    }
  });

/** A startup configuration error that contains setting names and safe guidance only. */
export class EnvironmentConfigurationError extends Error {
  constructor(messages: readonly string[]) {
    super(`Invalid environment configuration: ${messages.join("; ")}`);
    this.name = "EnvironmentConfigurationError";
  }
}

/** Parse configuration with diagnostics that never include rejected input values. */
export function parseEnvironment(input: NodeJS.ProcessEnv | Record<string, unknown>) {
  const result = envSchema.safeParse(input);
  if (result.success) return result.data;

  const messages = result.error.issues.map((issue) => {
    const setting = issue.path.length > 0 ? issue.path.join(".") : "environment";
    // Zod's native messages are useful but can echo invalid input. Only our fixed,
    // reviewed custom messages are safe to include verbatim.
    const detail = issue.code === "custom" ? issue.message : "has an invalid value or format";
    return `${setting}: ${detail}`;
  });
  throw new EnvironmentConfigurationError(messages);
}

// Validate the real process environment when the application starts.
export const env = parseEnvironment(process.env);
