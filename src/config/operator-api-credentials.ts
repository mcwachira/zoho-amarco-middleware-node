import { z } from "zod";

export const API_PERMISSION_VALUES = [
  "invoice:read",
  "request:create",
  "request:read",
  "device:operate",
  "etims:reconcile",
  "profile:manage",
  "admin:configure",
  "manual-review:decide",
  "invoice:writeback",
] as const;

export type ApiPermission = (typeof API_PERMISSION_VALUES)[number];

export interface NamedOperatorCredential {
  readonly subject: string;
  readonly token: string;
  readonly permissions: readonly ApiPermission[];
}

const namedOperatorCredentialSchema = z
  .object({
    subject: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .refine((subject) => subject !== "configured-operator" && subject !== "configured-service"),
    token: z
      .string()
      .min(32)
      .refine((token) => token.trim() === token),
    permissions: z.array(z.enum(API_PERMISSION_VALUES)).min(1).max(API_PERMISSION_VALUES.length),
  })
  .strict()
  .superRefine((credential, context) => {
    if (!credential.permissions.includes("invoice:read")) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "Operator credentials must include invoice:read for the Zoho API route boundary.",
      });
    }
    if (new Set(credential.permissions).size !== credential.permissions.length) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "Permissions must not contain duplicates.",
      });
    }
  });

const namedOperatorCredentialsSchema = z
  .array(namedOperatorCredentialSchema)
  .min(1)
  .max(100)
  .superRefine((credentials, context) => {
    const subjects = new Set<string>();
    const tokens = new Set<string>();
    credentials.forEach((credential, index) => {
      if (subjects.has(credential.subject)) {
        context.addIssue({
          code: "custom",
          path: [index, "subject"],
          message: "Operator subjects must be unique.",
        });
      }
      if (tokens.has(credential.token)) {
        context.addIssue({
          code: "custom",
          path: [index, "token"],
          message: "Operator credentials must use unique tokens.",
        });
      }
      subjects.add(credential.subject);
      tokens.add(credential.token);
    });
  });

/** Parses named operator credentials without including secret values in errors. */
export function parseNamedOperatorCredentials(
  serialized: string,
): readonly NamedOperatorCredential[] {
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("OPERATOR_API_CREDENTIALS_JSON must contain valid JSON.");
  }
  const result = namedOperatorCredentialsSchema.safeParse(input);
  if (!result.success) {
    throw new Error("OPERATOR_API_CREDENTIALS_JSON has an invalid credential or permission entry.");
  }
  return result.data;
}
