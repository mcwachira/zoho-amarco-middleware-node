import "dotenv/config";
import { z } from "zod";

const envSchema = z
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

    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
  })
  .superRefine((value, context) => {
    if (value.DATABASE_PROVIDER === "postgresql" && !value.DATABASE_URL?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URL is required when DATABASE_PROVIDER is postgresql",
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
  });

export const env = envSchema.parse(process.env);
