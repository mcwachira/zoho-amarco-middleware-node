/**
 * Minimal HTTP transport contract.
 *
 * Tests can inject a fake implementation; production can use native fetch.
 */
import { parseZohoAccountsDomain } from "./accounts-domain.js";
import { parseZohoBooksApiDomain } from "./api-domain.js";
export type ZohoTokenExchangeTransport = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Configuration required to exchange a Zoho authorization code for tokens.
 *
 * These credentials must remain server-side and must never be returned
 * to the browser or included in application logs.
 */
export interface ZohoTokenExchangeOptions {
  accountsUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}
/**
 * Configuration required to refresh a Zoho access token.
 *
 * The refresh token and client credentials must remain server-side.
 */
export interface ZohoTokenRefreshOptions {
  accountsUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}
/**
 * Tokens returned by Zoho after a successful authorization-code exchange.
 *
 * The refresh token is optional because Zoho may not return a new one
 * when an account has already authorized the application.
 */
export interface ZohoTokenExchangeResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  apiDomain: string;
  scopes: string;
}

/** Scope may be omitted from Zoho refresh-token responses. */
export interface ZohoTokenRefreshResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  apiDomain: string;
  scopes?: string;
}

/**
 * Validates the configured Zoho Accounts URL before sending OAuth credentials.
 *
 * Rejects malformed URLs, non-HTTPS URLs, embedded credentials, and
 * destinations outside the official Zoho Accounts host allowlist.
 */
function validateZohoAccountsUrl(value: string): URL {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error("Invalid Zoho Accounts URL.");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Zoho Accounts URL must use HTTPS.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("Zoho Accounts URL must not contain credentials.");
  }

  const trustedUrl = parseZohoAccountsDomain(value);

  if (trustedUrl === null) {
    throw new Error("Zoho Accounts URL must be an official HTTPS endpoint.");
  }

  return trustedUrl;
}

function parseTokenResponse(value: unknown, requireScopes: true): ZohoTokenExchangeResponse;
function parseTokenResponse(value: unknown, requireScopes: false): ZohoTokenRefreshResponse;
function parseTokenResponse(
  value: unknown,
  requireScopes: boolean,
): ZohoTokenExchangeResponse | ZohoTokenRefreshResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Zoho returned an invalid token response.");
  }

  const data = value as Record<string, unknown>;
  const accessToken = data["access_token"];
  const refreshToken = data["refresh_token"];
  const expiresIn = data["expires_in"];
  const apiDomain = data["api_domain"];
  const scopes = data["scope"];

  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new Error("Zoho token response is missing a valid access token.");
  }

  if (
    refreshToken !== undefined &&
    (typeof refreshToken !== "string" || refreshToken.trim() === "")
  ) {
    throw new Error("Zoho token response contains an invalid refresh token.");
  }

  const parsedExpiresIn =
    typeof expiresIn === "number"
      ? expiresIn
      : typeof expiresIn === "string" && expiresIn.trim() !== ""
        ? Number(expiresIn)
        : Number.NaN;

  if (!Number.isSafeInteger(parsedExpiresIn) || parsedExpiresIn <= 0) {
    throw new Error("Zoho token response contains an invalid expiry.");
  }

  if (typeof apiDomain !== "string" || apiDomain.trim() === "") {
    throw new Error("Zoho token response is missing a valid API domain.");
  }

  const parsedApiDomain = parseZohoBooksApiDomain(apiDomain);

  if (parsedApiDomain === null) {
    throw new Error("Zoho token response contains an invalid API domain.");
  }

  if (
    (scopes === undefined && requireScopes) ||
    (scopes !== undefined && (typeof scopes !== "string" || scopes.trim() === ""))
  ) {
    throw new Error("Zoho token response is missing valid scopes.");
  }

  return {
    accessToken,
    ...(typeof refreshToken === "string" ? { refreshToken } : {}),
    expiresIn: parsedExpiresIn,
    apiDomain: parsedApiDomain.origin,
    ...(typeof scopes === "string" ? { scopes } : {}),
  };
}

export async function exchangeZohoAuthorizationCode(
  options: ZohoTokenExchangeOptions,
  transport: ZohoTokenExchangeTransport = fetch,
): Promise<ZohoTokenExchangeResponse> {
  // Validate the configured Zoho Accounts URL before using it.
  const accountsUrl = validateZohoAccountsUrl(options.accountsUrl);

  // Use the configured regional Accounts host for token exchange.
  const tokenUrl = new URL("/oauth/v2/token", accountsUrl);

  // Send the authorization code and PKCE verifier to Zoho.
  const requestBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: options.clientId,
    client_secret: options.clientSecret,
    redirect_uri: options.redirectUri,
    code: options.code,
    code_verifier: options.codeVerifier,
  });

  const response = await transport(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: requestBody,
    signal: AbortSignal.timeout(10_000),
  });

  // Do not include the response body in errors: it may contain sensitive data.
  if (!response.ok) {
    throw new Error(`Zoho token exchange failed with HTTP status ${response.status}.`);
  }

  // Validate the provider response before returning tokens to the caller.
  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    throw new Error("Zoho returned an invalid JSON token response.");
  }

  return parseTokenResponse(responseBody, true);
}
/**
 * Exchanges a stored refresh token for a new access token.
 *
 * The transport is injectable so tests can run without network access.
 * Never include credentials, tokens, or provider response bodies in errors.
 */
export async function refreshZohoAccessToken(
  options: ZohoTokenRefreshOptions,
  transport: ZohoTokenExchangeTransport = fetch,
): Promise<ZohoTokenRefreshResponse> {
  const accountsUrl = validateZohoAccountsUrl(options.accountsUrl);

  if (!options.clientId.trim() || !options.clientSecret.trim() || !options.refreshToken.trim()) {
    throw new Error("Zoho client credentials and refresh token are required.");
  }

  const tokenUrl = new URL("/oauth/v2/token", accountsUrl);

  const requestBody = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: options.refreshToken,
  });

  const response = await transport(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: requestBody,
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Zoho token refresh failed with HTTP status ${response.status}.`);
  }

  let responseBody: unknown;

  try {
    responseBody = await response.json();
  } catch {
    throw new Error("Zoho returned an invalid JSON token response.");
  }

  return parseTokenResponse(responseBody, false);
}
