import { parseZohoAccountsDomain } from "./accounts-domain.js";

/**
 * Builds the URL that redirects an administrator to Zoho's OAuth consent
 * screen.
 *
 * This module only constructs a URL. It does not make HTTP requests,
 * generate OAuth state, store PKCE verifiers, or exchange authorization codes.
 */

export interface ZohoAuthorizationUrlOptions {
  /** Zoho Accounts base URL for the account's data-center region. */
  accountsUrl: string;

  /** Client ID from the Zoho API Console. Never put the client secret here. */
  clientId: string;

  /** Must match the redirect URI registered in the Zoho API Console. */
  redirectUri: string;

  /** Random, short-lived value that our callback will validate later. */
  state: string;

  /** PKCE S256 challenge derived from a separately stored verifier. */
  codeChallenge: string;
}

/**
 * Returns the Zoho authorization URL for the authorization-code flow.
 *
 * Inputs are explicit so this function can be tested without loading
 * environment variables or contacting Zoho.
 */
export function buildZohoAuthorizationUrl(options: ZohoAuthorizationUrlOptions): URL {
  const { accountsUrl, clientId, redirectUri, state, codeChallenge } = options;

  // Fail early if required values are missing or contain only whitespace.
  if (!clientId.trim() || !redirectUri.trim() || !state.trim() || !codeChallenge.trim()) {
    throw new Error("Zoho authorization URL parameters must not be blank");
  }

  // Only allow approved Zoho Accounts origins.
  // This prevents OAuth parameters from being sent to an untrusted host.
  const accountsBaseUrl = parseZohoAccountsDomain(accountsUrl);

  if (accountsBaseUrl === null) {
    let parsedUrl: URL;

    try {
      parsedUrl = new URL(accountsUrl);
    } catch {
      throw new Error("Zoho Accounts URL must be a valid HTTPS URL");
    }

    if (parsedUrl.protocol !== "https:") {
      throw new Error("Zoho Accounts URL must use HTTPS");
    }

    throw new Error("Zoho Accounts URL must be an official HTTPS endpoint");
  }
  // The registered callback may use HTTP for local development. Production
  // deployments should use HTTPS.
  let callbackUrl: URL;

  try {
    callbackUrl = new URL(redirectUri);
  } catch {
    throw new Error("Zoho redirect URI must be a valid URL");
  }

  if (callbackUrl.username !== "" || callbackUrl.password !== "") {
    throw new Error("Zoho redirect URI must not contain credentials");
  }

  if (
    callbackUrl.protocol !== "https:" &&
    !(
      callbackUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname)
    )
  ) {
    throw new Error("Zoho redirect URI must use HTTPS, except for localhost development");
  }

  // Build the authorization URL using URL APIs so parameters are encoded safely.
  const authorizationUrl = new URL("/oauth/v2/auth", accountsBaseUrl);

  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl.toString());
  authorizationUrl.searchParams.set("scope", "ZohoBooks.invoices.READ");
  authorizationUrl.searchParams.set("access_type", "offline");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");

  return authorizationUrl;
}
