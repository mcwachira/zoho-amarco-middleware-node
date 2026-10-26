import "dotenv/config";
import { z } from "zod";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_PROVIDER: z.enum(["postgresql", "sqlserver"]).default("postgresql"),
    DATABASE_URL: z.string().optional(),

    SQLSERVER_SERVER: z.string().optional(),
    SQLSERVER_DATABASE: z.string().optional(),
    SQLSERVER_USER: z.string().optional(),
    SQLSERVER_PASSWORD: z.string().optional(),
    SQLSERVER_PORT: z.coerce.number().int().min(1).max(65535).default(1433),
    SQLSERVER_ENCRYPT: z.enum(["true", "false"]).default("true"),
    SQLSERVER_TRUST_SERVER_CERTIFICATE: z.enum(["true", "false"]).default("false"),
    // Protect invoice endpoints from unauthorized access.
    // Generate a strong random token and keep it out of source control.
    INVOICE_API_BEARER_TOKEN: z.string().trim().min(32).optional(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
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

    // Zoho Books OAuth credentials remain optional during development.
    // If provided, each credential must contain a non-whitespace value.
    ZOHO_CLIENT_ID: z.string().trim().min(1).optional(),
    ZOHO_CLIENT_SECRET: z.string().trim().min(1).optional(),
    ZOHO_ORGANIZATION_ID: z.string().trim().min(1).optional(),

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
    if (value.DATABASE_PROVIDER === "postgresql" && !value.DATABASE_URL?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when DATABASE_PROVIDER is postgresql",
      });
    }

    if (value.NODE_ENV === "production" && !value.INVOICE_API_BEARER_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["INVOICE_API_BEARER_TOKEN"],
        message: "INVOICE_API_BEARER_TOKEN is required in production",
      });
    }

    if (value.DATABASE_PROVIDER === "sqlserver") {
      for (const key of [
        "SQLSERVER_SERVER",
        "SQLSERVER_DATABASE",
        "SQLSERVER_USER",
        "SQLSERVER_PASSWORD",
      ] as const) {
        if (!value[key]?.trim()) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when DATABASE_PROVIDER is sqlserver`,
          });
        }
      }
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
  });

// Validate the real process environment when the application starts.
export const env = envSchema.parse(process.env);
