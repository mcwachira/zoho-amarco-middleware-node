import { createHash, randomBytes } from "node:crypto";

import type { ZohoOAuthAttemptRepository } from "./oauth-attempt-repository.js";
import { buildZohoAuthorizationUrl } from "../../integrations/zoho/authorization-url.js";
import {
  encryptCodeVerifier,
  decryptCodeVerifier,
} from "../../integrations/zoho/verifier-encryption.js";
import { generatePkcePair } from "../../integrations/zoho/pkce.js";
import type { ZohoTokenRepository } from "./zoho-token-repository.js";
import { encryptSecret, decryptSecret } from "../../integrations/zoho/secret-encryption.js";
import {
  exchangeZohoAuthorizationCode,
  refreshZohoAccessToken,
  type ZohoTokenRefreshOptions,
  type ZohoTokenExchangeOptions,
  type ZohoTokenExchangeResponse,
  type ZohoTokenRefreshResponse,
} from "../../integrations/zoho/token-exchange.js";

/** Authorization attempts expire after ten minutes. */
const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;

export type ZohoTokenExchange = (
  options: ZohoTokenExchangeOptions,
) => Promise<ZohoTokenExchangeResponse>;

export type ZohoTokenRefresh = (
  options: ZohoTokenRefreshOptions,
) => Promise<ZohoTokenRefreshResponse>;

export interface ZohoOAuthServiceOptions {
  repository: ZohoOAuthAttemptRepository;
  clientId: string;
  redirectUri: string;
  accountsUrl: string;
  encryptionKey: string | undefined;
  now?: () => Date;
  clientSecret: string;
  tokenRepository: ZohoTokenRepository;
  tokenExchange?: ZohoTokenExchange;
  tokenRefresh?: ZohoTokenRefresh;
}

export interface ZohoOAuthStartResult {
  authorizationUrl: string;
}

/**
 * Coordinates the security-sensitive parts of the Zoho OAuth flow.
 *
 * Starts authorization, validates callback state, exchanges authorization
 * codes, encrypts returned tokens, and persists them securely.
 */
export class ZohoOAuthService {
  private readonly repository: ZohoOAuthAttemptRepository;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly accountsUrl: string;
  private readonly encryptionKey: string | undefined;
  private readonly clientSecret: string;
  private readonly tokenRepository: ZohoTokenRepository;
  private readonly tokenExchange: ZohoTokenExchange;
  private readonly now: () => Date;
  private readonly tokenRefresh: ZohoTokenRefresh;

  private refreshInFlight: Promise<{
    accessToken: string;
    apiDomain: string;
    scopes: string;
  }> | null = null;

  constructor(options: ZohoOAuthServiceOptions) {
    this.repository = options.repository;
    this.clientId = options.clientId;
    this.redirectUri = options.redirectUri;
    this.accountsUrl = options.accountsUrl;
    this.encryptionKey = options.encryptionKey;
    this.clientSecret = options.clientSecret;
    this.tokenRepository = options.tokenRepository;
    this.tokenExchange = options.tokenExchange ?? exchangeZohoAuthorizationCode;
    this.tokenRefresh = options.tokenRefresh ?? refreshZohoAccessToken;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Creates a new authorization URL and persists the information needed
   * to validate its callback.
   */
  async startAuthorization(): Promise<ZohoOAuthStartResult> {
    const encryptionKey = this.requireEncryptionKey();

    // State protects the callback against unsolicited and forged requests.
    const state = randomBytes(32).toString("base64url");
    const stateHash = createHash("sha256").update(state, "utf8").digest("hex");

    // Only the challenge is sent to Zoho; the verifier stays encrypted.
    const pkce = generatePkcePair();
    const encryptedCodeVerifier = encryptCodeVerifier(pkce.verifier, encryptionKey);

    const startedAt = this.now();
    const expiresAt = new Date(startedAt.getTime() + OAUTH_ATTEMPT_TTL_MS);

    // Persist before returning the URL so a fast callback cannot arrive
    // before the attempt exists in the database.
    await this.repository.create({
      stateHash,
      encryptedCodeVerifier,
      expiresAt,
    });

    const authorizationUrl = buildZohoAuthorizationUrl({
      accountsUrl: this.accountsUrl,
      clientId: this.clientId,
      redirectUri: this.redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });

    return { authorizationUrl: authorizationUrl.toString() };
  }

  /**
   * Exchanges an authorization code and securely persists the resulting tokens.
   *
   * This method never returns token values to its caller.
   */
  async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<void> {
    if (!code.trim() || !codeVerifier.trim()) {
      throw new Error("Authorization code and PKCE verifier are required.");
    }

    const encryptionKey = this.requireEncryptionKey();

    const tokens = await this.tokenExchange({
      accountsUrl: this.accountsUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      code,
      codeVerifier,
    });

    // Encrypt credentials before they cross the persistence boundary.
    const encryptedAccessToken = encryptSecret(tokens.accessToken, encryptionKey);

    const encryptedRefreshToken = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken, encryptionKey)
      : undefined;

    // Use the injected clock to keep expiry calculations deterministic in tests.
    const accessTokenExpiresAt = new Date(this.now().getTime() + tokens.expiresIn * 1000);

    await this.tokenRepository.save({
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      accessTokenExpiresAt,
      apiDomain: tokens.apiDomain,
      scopes: tokens.scopes,
    });
  }

  /**
   * Returns an access token for trusted server-side Zoho API calls.
   *
   * Refreshes early to reduce the chance that a token expires during a request.
   * Concurrent refreshes within this process share the same promise.
   *
   * Never return this result directly from an HTTP route or log its token.
   */
  async getAccessToken(): Promise<{
    accessToken: string;
    apiDomain: string;
    scopes: string;
  }> {
    const encryptionKey = this.requireEncryptionKey();
    const stored = await this.tokenRepository.get();

    if (!stored) {
      throw new Error("Zoho is not connected.");
    }

    const refreshThresholdMs = 60_000;
    const refreshAt = stored.accessTokenExpiresAt.getTime() - refreshThresholdMs;

    if (refreshAt > this.now().getTime()) {
      return {
        accessToken: decryptSecret(stored.encryptedAccessToken, encryptionKey),
        apiDomain: stored.apiDomain,
        scopes: stored.scopes,
      };
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    const refreshPromise = this.refreshStoredTokens(stored, encryptionKey);
    this.refreshInFlight = refreshPromise;

    try {
      return await refreshPromise;
    } finally {
      if (this.refreshInFlight === refreshPromise) {
        this.refreshInFlight = null;
      }
    }
  }

  /**
   * Exchanges the stored refresh token and persists the new access token.
   */
  private async refreshStoredTokens(
    stored: NonNullable<Awaited<ReturnType<ZohoTokenRepository["get"]>>>,
    encryptionKey: string,
  ): Promise<{
    accessToken: string;
    apiDomain: string;
    scopes: string;
  }> {
    if (!stored.encryptedRefreshToken) {
      throw new Error(
        "Zoho access token has expired or is expiring, but no refresh token is stored. Reauthorize Zoho.",
      );
    }

    const refreshToken = decryptSecret(stored.encryptedRefreshToken, encryptionKey);

    const tokens = await this.tokenRefresh({
      accountsUrl: this.accountsUrl,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      refreshToken,
    });

    const scopes = tokens.scopes ?? stored.scopes;

    const encryptedAccessToken = encryptSecret(tokens.accessToken, encryptionKey);

    const encryptedRefreshToken = tokens.refreshToken
      ? encryptSecret(tokens.refreshToken, encryptionKey)
      : undefined;

    const accessTokenExpiresAt = new Date(this.now().getTime() + tokens.expiresIn * 1000);

    await this.tokenRepository.save({
      encryptedAccessToken,
      ...(encryptedRefreshToken ? { encryptedRefreshToken } : {}),
      accessTokenExpiresAt,
      apiDomain: tokens.apiDomain,
      scopes,
    });

    return {
      accessToken: tokens.accessToken,
      apiDomain: tokens.apiDomain,
      scopes,
    };
  }

  /**
   * Validates and consumes a callback state, returning its PKCE verifier.
   *
   * The caller must reject the callback if this method returns null.
   * Successful consumption is one-time, enforced by the repository.
   */
  async consumeCallbackState(state: string): Promise<{ codeVerifier: string } | null> {
    if (!state.trim()) {
      return null;
    }

    const encryptionKey = this.requireEncryptionKey();

    const stateHash = createHash("sha256").update(state, "utf8").digest("hex");

    const attempt = await this.repository.consume(stateHash, this.now());

    if (!attempt) {
      return null;
    }

    // Decrypt only after the repository confirms this state was claimed.
    const codeVerifier = decryptCodeVerifier(attempt.encryptedCodeVerifier, encryptionKey);

    return { codeVerifier };
  }

  private requireEncryptionKey(): string {
    if (!this.encryptionKey) {
      throw new Error("ZOHO_OAUTH_ENCRYPTION_KEY must be configured for OAuth");
    }

    return this.encryptionKey;
  }
}
