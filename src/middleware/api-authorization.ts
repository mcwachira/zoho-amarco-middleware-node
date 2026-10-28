import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { ApiPermission, NamedOperatorCredential } from "../config/operator-api-credentials.js";

export type { ApiPermission } from "../config/operator-api-credentials.js";

export interface ApiIdentity {
  readonly subject: string;
  readonly role: "service" | "operator";
  readonly permissions: ReadonlySet<ApiPermission>;
}

const SERVICE_PERMISSIONS: ReadonlySet<ApiPermission> = new Set([
  "invoice:read",
  "request:create",
  "request:read",
]);
const OPERATOR_PERMISSIONS: ReadonlySet<ApiPermission> = new Set([
  ...SERVICE_PERMISSIONS,
  "device:operate",
  "etims:reconcile",
  "profile:manage",
  "admin:configure",
  "manual-review:decide",
  "invoice:writeback",
]);

function equalToken(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

/** Static token identity boundary for local deployments; roles are derived from
 * configured secrets, never from caller-supplied headers or request bodies. */
export function authenticateApiToken(
  serviceToken: string | undefined,
  operatorToken?: string,
  namedOperators: readonly NamedOperatorCredential[] = [],
): RequestHandler {
  return (req, res, next) => {
    if (!serviceToken && !operatorToken && namedOperators.length === 0) {
      res.status(503).json({
        error: { code: "API_AUTH_UNAVAILABLE", message: "API authentication is not configured." },
      });
      return;
    }
    const allOperatorTokens = [
      ...(operatorToken ? [operatorToken] : []),
      ...namedOperators.map(({ token }) => token),
    ];
    const duplicateOperatorTokens = new Set(allOperatorTokens).size !== allOperatorTokens.length;
    const collidesWithServiceToken =
      serviceToken !== undefined &&
      allOperatorTokens.some((token) => equalToken(serviceToken, token));
    if (
      duplicateOperatorTokens ||
      collidesWithServiceToken ||
      (operatorToken !== undefined && namedOperators.length > 0)
    ) {
      res.status(503).json({
        error: {
          code: "API_AUTH_CONFIGURATION_INVALID",
          message: "Service and operator credentials must be configured as distinct identities.",
        },
      });
      return;
    }
    const match = req.get("authorization")?.match(/^Bearer ([^\s]+)$/i);
    if (!match) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." } });
      return;
    }
    const token = match[1]!;
    const service = serviceToken ? equalToken(token, serviceToken) : false;
    const matchingOperators = namedOperators.filter((credential) =>
      equalToken(token, credential.token),
    );
    const legacyOperator = operatorToken !== undefined && equalToken(token, operatorToken);
    if (matchingOperators.length > 1 || (legacyOperator && matchingOperators.length > 0)) {
      res.status(503).json({
        error: {
          code: "API_AUTH_CONFIGURATION_INVALID",
          message: "Operator credentials do not identify a unique operator.",
        },
      });
      return;
    }
    const operator = legacyOperator || matchingOperators.length === 1;
    if (service && operator) {
      res.status(503).json({
        error: {
          code: "API_AUTH_CONFIGURATION_INVALID",
          message: "Service and operator credentials must be configured separately.",
        },
      });
      return;
    }
    if (!operator && !service) {
      res.setHeader("WWW-Authenticate", "Bearer");
      res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "A valid bearer token is required." } });
      return;
    }
    const namedOperator = matchingOperators[0];
    res.locals["apiIdentity"] = operator
      ? namedOperator
        ? {
            subject: namedOperator.subject,
            role: "operator",
            permissions: new Set(namedOperator.permissions),
          }
        : { subject: "configured-operator", role: "operator", permissions: OPERATOR_PERMISSIONS }
      : { subject: "configured-service", role: "service", permissions: SERVICE_PERMISSIONS };
    next();
  };
}

export function requirePermission(permission: ApiPermission): RequestHandler {
  return (_req, res, next) => {
    const identity = getApiIdentity(res);
    if (!identity) {
      res
        .status(401)
        .json({ error: { code: "UNAUTHORIZED", message: "Authentication is required." } });
      return;
    }
    if (!identity.permissions.has(permission)) {
      res.status(403).json({
        error: {
          code: "FORBIDDEN",
          message: "The authenticated identity lacks permission for this operation.",
        },
      });
      return;
    }
    next();
  };
}

export function getApiIdentity(response: Response): ApiIdentity | undefined {
  const identity = response.locals["apiIdentity"];
  return typeof identity === "object" && identity !== null ? (identity as ApiIdentity) : undefined;
}

/** Backward-compatible name for callers that only need to authenticate. */
export const requireInvoiceApiToken = authenticateApiToken;
