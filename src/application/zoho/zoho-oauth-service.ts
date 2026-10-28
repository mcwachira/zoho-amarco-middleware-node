import { createHash, randomBytes, randomUUID } from "node:crypto";

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
const TOKEN_REFRESH_LEASE_MS = 30_000;
const TOKEN_REFRESH_WAIT_MS = 35_000;
const TOKEN_REFRESH_POLL_MS = 100;

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
  sleep?: (milliseconds: number) => Promise<void>;
  scopes?: readonly ("ZohoBooks.invoices.READ" | "ZohoBooks.invoices.UPDATE")[];
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
  private readonly scopes: readonly ("ZohoBooks.invoices.READ" | "ZohoBooks.invoices.UPDATE")[];
  private readonly encryptionKey: string | undefined;
  private readonly clientSecret: string;
  private readonly tokenRepository: ZohoTokenRepository;
  private readonly tokenExchange: ZohoTokenExchange;
  private readonly now: () => Date;
  private readonly tokenRefresh: ZohoTokenRefresh;
  private readonly sleep: (milliseconds: number) => Promise<void>;

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
    this.scopes = options.scopes ?? ["ZohoBooks.invoices.READ"];
    this.encryptionKey = options.encryptionKey;
    this.clientSecret = options.clientSecret;
    this.tokenRepository = options.tokenRepository;
    this.tokenExchange = options.tokenExchange ?? exchangeZohoAuthorizationCode;
    this.tokenRefresh = options.tokenRefresh ?? refreshZohoAccessToken;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
      scopes: this.scopes,
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

    const refreshPromise = this.refreshStoredTokens(encryptionKey);
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
  private async refreshStoredTokens(encryptionKey: string): Promise<{
    accessToken: string;
    apiDomain: string;
    scopes: string;
  }> {
    const leaseToken = randomUUID();
    const waitDeadline = Date.now() + TOKEN_REFRESH_WAIT_MS;
    let acquired = false;

    while (!acquired) {
      const now = this.now();
      acquired = await this.tokenRepository.tryAcquireRefreshLease(
        leaseToken,
        now,
        new Date(now.getTime() + TOKEN_REFRESH_LEASE_MS),
      );
      if (acquired) break;

      const current = await this.tokenRepository.get();
      if (!current) throw new Error("Zoho is not connected.");
      if (this.isAccessTokenFresh(current))
        return this.decryptStoredAccessToken(current, encryptionKey);
      if (Date.now() >= waitDeadline) {
        throw new Error(
          "Zoho token refresh is already in progress; retry the API request shortly.",
        );
      }
      await this.sleep(TOKEN_REFRESH_POLL_MS);
    }

    let savedByThisLease = false;
    try {
      // A prior lease holder may have completed between our initial read and
      // this claim. Always use the newest token row before contacting Zoho.
      const current = await this.tokenRepository.get();
      if (!current) throw new Error("Zoho is not connected.");
      if (this.isAccessTokenFresh(current))
        return this.decryptStoredAccessToken(current, encryptionKey);
      if (!current.encryptedRefreshToken) {
        throw new Error(
          "Zoho access token has expired or is expiring, but no refresh token is stored. Reauthorize Zoho.",
        );
      }

      const tokens = await this.tokenRefresh({
        accountsUrl: this.accountsUrl,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: decryptSecret(current.encryptedRefreshToken, encryptionKey),
      });
      const scopes = tokens.scopes ?? current.scopes;
      const saved = await this.tokenRepository.saveRefreshedTokens(leaseToken, this.now(), {
        encryptedAccessToken: encryptSecret(tokens.accessToken, encryptionKey),
        ...(tokens.refreshToken
          ? { encryptedRefreshToken: encryptSecret(tokens.refreshToken, encryptionKey) }
          : {}),
        accessTokenExpiresAt: new Date(this.now().getTime() + tokens.expiresIn * 1000),
        apiDomain: tokens.apiDomain,
        scopes,
      });
      if (!saved) {
        const latest = await this.tokenRepository.get();
        if (latest && this.isAccessTokenFresh(latest)) {
          return this.decryptStoredAccessToken(latest, encryptionKey);
        }
        throw new Error("Zoho token refresh lease was lost before credentials could be saved.");
      }

      savedByThisLease = true;
      return { accessToken: tokens.accessToken, apiDomain: tokens.apiDomain, scopes };
    } finally {
      if (!savedByThisLease) await this.tokenRepository.releaseRefreshLease(leaseToken);
    }
  }

  private isAccessTokenFresh(stored: NonNullable<Awaited<ReturnType<ZohoTokenRepository["get"]>>>) {
    return stored.accessTokenExpiresAt.getTime() - 60_000 > this.now().getTime();
  }

  private decryptStoredAccessToken(
    stored: NonNullable<Awaited<ReturnType<ZohoTokenRepository["get"]>>>,
    encryptionKey: string,
  ) {
    return {
      accessToken: decryptSecret(stored.encryptedAccessToken, encryptionKey),
      apiDomain: stored.apiDomain,
      scopes: stored.scopes,
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
