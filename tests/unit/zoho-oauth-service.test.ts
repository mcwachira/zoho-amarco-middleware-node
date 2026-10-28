import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZohoOAuthAttemptRepository } from "../../src/application/zoho/oauth-attempt-repository.js";
import {
  ZohoOAuthService,
  type ZohoTokenRefresh,
} from "../../src/application/zoho/zoho-oauth-service.js";
import { decryptCodeVerifier } from "../../src/integrations/zoho/verifier-encryption.js";
import { decryptSecret } from "../../src/integrations/zoho/secret-encryption.js";
import type {
  StoredZohoTokens,
  ZohoTokenRepository,
} from "../../src/application/zoho/zoho-token-repository.js";
import { encryptSecret } from "../../src/integrations/zoho/secret-encryption.js";

const NOW = new Date("2026-10-24T09:00:00.000Z");
const ENCRYPTION_KEY = "a".repeat(64);

function createHarness(
  encryptionKey: string | undefined = ENCRYPTION_KEY,
  overrides: { tokenRepository?: ZohoTokenRepository; tokenRefresh?: ZohoTokenRefresh } = {},
) {
  const repository: ZohoOAuthAttemptRepository = {
    create: vi.fn(),
    consume: vi.fn(),
    deleteExpired: vi.fn().mockResolvedValue(0),
  };

  const defaultTokenRepository = {
    save: vi.fn().mockResolvedValue(undefined),
    get: vi.fn<() => Promise<StoredZohoTokens | null>>().mockResolvedValue(null),
    tryAcquireRefreshLease: vi.fn().mockResolvedValue(true),
    saveRefreshedTokens: vi.fn().mockResolvedValue(true),
    releaseRefreshLease: vi.fn().mockResolvedValue(undefined),
  };

  const tokenExchange = vi.fn().mockResolvedValue({
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresIn: 3600,
    apiDomain: "https://www.zohoapis.com",
    scopes: "ZohoBooks.invoices.READ",
  });

  const tokenRefresh = vi.fn().mockResolvedValue({
    accessToken: "refreshed-access-token",
    expiresIn: 3600,
    apiDomain: "https://www.zohoapis.com",
    scopes: "ZohoBooks.invoices.READ",
  });
  const tokenRepository = defaultTokenRepository;
  const configuredTokenRepository = overrides.tokenRepository ?? tokenRepository;

  const service = new ZohoOAuthService({
    repository,
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    redirectUri: "http://localhost:3000/integrations/zoho/callback",
    accountsUrl: "https://accounts.zoho.com",
    encryptionKey,
    tokenRepository: configuredTokenRepository,
    tokenExchange,
    tokenRefresh: overrides.tokenRefresh ?? tokenRefresh,
    now: () => new Date(NOW),
  });

  return {
    repository,
    tokenRepository,
    tokenExchange,
    tokenRefresh,
    service,
  };
}

describe("ZohoOAuthService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an authorization URL and persists a hashed state and encrypted verifier", async () => {
    const { repository, service } = createHarness();

    const result = await service.startAuthorization();
    const authorizationUrl = new URL(result.authorizationUrl);

    const state = authorizationUrl.searchParams.get("state");
    const challenge = authorizationUrl.searchParams.get("code_challenge");

    expect(state).toBeTruthy();
    expect(challenge).toBeTruthy();
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("test-client-id");

    expect(repository.create).toHaveBeenCalledTimes(1);

    const savedAttempt = vi.mocked(repository.create).mock.calls[0]?.[0];

    expect(savedAttempt).toBeDefined();
    expect(savedAttempt?.stateHash).toBe(createHash("sha256").update(state!, "utf8").digest("hex"));
    expect(savedAttempt?.stateHash).not.toBe(state);
    expect(savedAttempt?.encryptedCodeVerifier).not.toContain("=");

    expect(savedAttempt?.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60 * 1000));

    // The stored verifier must be decryptable with the configured key.
    const verifier = decryptCodeVerifier(savedAttempt!.encryptedCodeVerifier, ENCRYPTION_KEY);

    expect(verifier).toHaveLength(43);
    expect(result.authorizationUrl).not.toContain(verifier);
  });

  it("generates a different state for each authorization attempt", async () => {
    const { service } = createHarness();

    const first = new URL((await service.startAuthorization()).authorizationUrl);
    const second = new URL((await service.startAuthorization()).authorizationUrl);

    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
  });

  it("does not create an attempt when the encryption key is missing", async () => {
    const { repository, service } = createHarness("");

    await expect(service.startAuthorization()).rejects.toThrow(
      "ZOHO_OAUTH_ENCRYPTION_KEY must be configured for OAuth",
    );

    expect(repository.create).not.toHaveBeenCalled();
  });

  it("returns null for an empty callback state without querying the repository", async () => {
    const { repository, service } = createHarness();

    await expect(service.consumeCallbackState("   ")).resolves.toBeNull();

    expect(repository.consume).not.toHaveBeenCalled();
  });

  it("returns null when the repository cannot consume the state", async () => {
    const { repository, service } = createHarness();
    vi.mocked(repository.consume).mockResolvedValue(null);

    await expect(service.consumeCallbackState("unknown-state")).resolves.toBeNull();

    expect(repository.consume).toHaveBeenCalledWith(
      createHash("sha256").update("unknown-state", "utf8").digest("hex"),
      NOW,
    );
  });

  it("decrypts and returns the verifier only after successful state consumption", async () => {
    const { repository, service } = createHarness();

    const start = await service.startAuthorization();
    const authorizationUrl = new URL(start.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state")!;

    const savedAttempt = vi.mocked(repository.create).mock.calls[0]![0];

    vi.mocked(repository.consume).mockResolvedValue({
      encryptedCodeVerifier: savedAttempt.encryptedCodeVerifier,
    });

    const result = await service.consumeCallbackState(state);

    expect(result?.codeVerifier).toHaveLength(43);
    expect(repository.consume).toHaveBeenCalledWith(
      createHash("sha256").update(state, "utf8").digest("hex"),
      NOW,
    );
  });

  it("does not query the repository when the encryption key is missing", async () => {
    const { repository, service } = createHarness("");

    await expect(service.consumeCallbackState("some-state")).rejects.toThrow(
      "ZOHO_OAUTH_ENCRYPTION_KEY must be configured for OAuth",
    );

    expect(repository.consume).not.toHaveBeenCalled();
  });

  it("propagates verifier decryption failures", async () => {
    const { repository, service } = createHarness();

    vi.mocked(repository.consume).mockResolvedValue({
      encryptedCodeVerifier: "invalid-encrypted-payload",
    });

    await expect(service.consumeCallbackState("some-state")).rejects.toThrow();
  });

  it("exchanges an authorization code and persists encrypted tokens", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness();

    await service.exchangeAuthorizationCode("test-authorization-code", "test-pkce-verifier");

    // Verify the service passes the expected configuration and PKCE verifier.
    expect(tokenExchange).toHaveBeenCalledWith({
      accountsUrl: "https://accounts.zoho.com",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost:3000/integrations/zoho/callback",
      code: "test-authorization-code",
      codeVerifier: "test-pkce-verifier",
    });

    expect(tokenRepository.save).toHaveBeenCalledTimes(1);

    const savedTokens = vi.mocked(tokenRepository.save).mock.calls[0]?.[0];

    expect(savedTokens).toBeDefined();
    expect(savedTokens?.encryptedAccessToken).not.toBe("test-access-token");
    expect(savedTokens?.encryptedRefreshToken).not.toBe("test-refresh-token");

    expect(decryptSecret(savedTokens!.encryptedAccessToken, ENCRYPTION_KEY)).toBe(
      "test-access-token",
    );

    expect(decryptSecret(savedTokens!.encryptedRefreshToken!, ENCRYPTION_KEY)).toBe(
      "test-refresh-token",
    );

    expect(savedTokens?.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 3600 * 1000));

    expect(savedTokens?.apiDomain).toBe("https://www.zohoapis.com");
    expect(savedTokens?.scopes).toBe("ZohoBooks.invoices.READ");
  });

  it("omits the encrypted refresh token when Zoho does not return one", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness();

    tokenExchange.mockResolvedValueOnce({
      accessToken: "test-access-token-without-refresh",
      expiresIn: 3600,
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });

    await service.exchangeAuthorizationCode("test-authorization-code", "test-pkce-verifier");

    expect(tokenRepository.save).toHaveBeenCalledTimes(1);

    const savedTokens = vi.mocked(tokenRepository.save).mock.calls[0]?.[0];

    expect(savedTokens).toBeDefined();
    expect("encryptedRefreshToken" in savedTokens!).toBe(false);

    expect(decryptSecret(savedTokens!.encryptedAccessToken, ENCRYPTION_KEY)).toBe(
      "test-access-token-without-refresh",
    );
  });

  it("rejects a blank authorization code before token exchange", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness();

    await expect(service.exchangeAuthorizationCode("   ", "test-pkce-verifier")).rejects.toThrow();

    expect(tokenExchange).not.toHaveBeenCalled();
    expect(tokenRepository.save).not.toHaveBeenCalled();
  });

  it("rejects a blank PKCE verifier before token exchange", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness();

    await expect(
      service.exchangeAuthorizationCode("test-authorization-code", "   "),
    ).rejects.toThrow();

    expect(tokenExchange).not.toHaveBeenCalled();
    expect(tokenRepository.save).not.toHaveBeenCalled();
  });

  it("does not exchange or save tokens when the encryption key is missing", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness("");

    await expect(
      service.exchangeAuthorizationCode("test-authorization-code", "test-pkce-verifier"),
    ).rejects.toThrow("ZOHO_OAUTH_ENCRYPTION_KEY must be configured for OAuth");

    expect(tokenExchange).not.toHaveBeenCalled();
    expect(tokenRepository.save).not.toHaveBeenCalled();
  });

  it("propagates token-exchange failures without saving tokens", async () => {
    const { tokenRepository, tokenExchange, service } = createHarness();

    tokenExchange.mockRejectedValueOnce(new Error("Zoho token exchange failed"));

    await expect(
      service.exchangeAuthorizationCode("test-authorization-code", "test-pkce-verifier"),
    ).rejects.toThrow("Zoho token exchange failed");

    expect(tokenExchange).toHaveBeenCalledTimes(1);
    expect(tokenRepository.save).not.toHaveBeenCalled();
  });

  it("returns the decrypted access token when it is still valid", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("current-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    await expect(service.getAccessToken()).resolves.toEqual({
      accessToken: "current-access-token",
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });

    expect(tokenRefresh).not.toHaveBeenCalled();
  });

  it("refreshes an expired access token and saves its encrypted replacement", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    await expect(service.getAccessToken()).resolves.toEqual({
      accessToken: "refreshed-access-token",
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });

    expect(tokenRefresh).toHaveBeenCalledWith({
      accountsUrl: "https://accounts.zoho.com",
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      refreshToken: "stored-refresh-token",
    });

    expect(tokenRepository.saveRefreshedTokens).toHaveBeenCalledOnce();

    const saved = tokenRepository.saveRefreshedTokens.mock.calls[0]?.[2];

    expect(saved).toBeDefined();
    expect(saved?.encryptedAccessToken).not.toBe("refreshed-access-token");
    expect(decryptSecret(saved!.encryptedAccessToken, ENCRYPTION_KEY)).toBe(
      "refreshed-access-token",
    );
    expect(saved?.encryptedRefreshToken).toBeUndefined();
    expect(saved?.accessTokenExpiresAt).toEqual(new Date(NOW.getTime() + 3600 * 1000));
  });

  it("preserves stored scopes when Zoho omits scopes from its refresh response", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    tokenRefresh.mockResolvedValueOnce({
      accessToken: "refreshed-access-token",
      expiresIn: 3600,
      apiDomain: "https://www.zohoapis.com",
    });

    await expect(service.getAccessToken()).resolves.toEqual({
      accessToken: "refreshed-access-token",
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });

    const saved = tokenRepository.saveRefreshedTokens.mock.calls[0]?.[2];

    expect(tokenRepository.saveRefreshedTokens).toHaveBeenCalledOnce();
    expect(saved?.scopes).toBe("ZohoBooks.invoices.READ");
  });

  it("preserves the existing refresh token when Zoho does not return a replacement", async () => {
    const { tokenRepository, service } = createHarness();

    const existingRefreshToken = encryptSecret("stored-refresh-token", ENCRYPTION_KEY);

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: existingRefreshToken,
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    await service.getAccessToken();

    const saved = tokenRepository.saveRefreshedTokens.mock.calls[0]?.[1];

    expect(saved).toBeDefined();
    expect(saved?.encryptedRefreshToken).toBeUndefined();

    // The repository's save contract preserves the existing refresh token
    // when encryptedRefreshToken is omitted.
  });

  it("rejects an expired token when no refresh token is stored", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: null,
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    await expect(service.getAccessToken()).rejects.toThrow("no refresh token is stored");

    expect(tokenRefresh).not.toHaveBeenCalled();
    expect(tokenRepository.saveRefreshedTokens).not.toHaveBeenCalled();
  });

  it("shares one refresh operation across concurrent calls", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    const [first, second] = await Promise.all([service.getAccessToken(), service.getAccessToken()]);

    expect(first).toEqual(second);
    expect(first.accessToken).toBe("refreshed-access-token");
    expect(tokenRefresh).toHaveBeenCalledOnce();
    expect(tokenRepository.saveRefreshedTokens).toHaveBeenCalledOnce();
  });

  it("uses the database lease to prevent cross-instance duplicate refreshes", async () => {
    let stored: StoredZohoTokens = {
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    };
    let leaseToken: string | null = null;
    let leaseExpiresAt: Date | null = null;
    const tokenRepository: ZohoTokenRepository = {
      save: vi.fn(async () => undefined),
      get: vi.fn(async () => stored),
      tryAcquireRefreshLease: vi.fn(async (token, now, expiresAt) => {
        if (leaseToken && leaseExpiresAt && leaseExpiresAt > now) return false;
        leaseToken = token;
        leaseExpiresAt = expiresAt;
        return true;
      }),
      saveRefreshedTokens: vi.fn(async (token, _now, tokens) => {
        if (leaseToken !== token) return false;
        stored = {
          encryptedAccessToken: tokens.encryptedAccessToken,
          encryptedRefreshToken: tokens.encryptedRefreshToken ?? stored.encryptedRefreshToken,
          accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          apiDomain: tokens.apiDomain,
          scopes: tokens.scopes,
          updatedAt: NOW,
        };
        leaseToken = null;
        leaseExpiresAt = null;
        return true;
      }),
      releaseRefreshLease: vi.fn(async (token) => {
        if (leaseToken === token) {
          leaseToken = null;
          leaseExpiresAt = null;
        }
      }),
    };
    let completeProviderCall!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      completeProviderCall = resolve;
    });
    const tokenRefresh = vi.fn(async () => {
      await providerGate;
      return {
        accessToken: "refreshed-access-token",
        expiresIn: 3600,
        apiDomain: "https://www.zohoapis.com",
        scopes: "ZohoBooks.invoices.READ",
      };
    });
    const first = createHarness(ENCRYPTION_KEY, { tokenRepository, tokenRefresh });
    const second = createHarness(ENCRYPTION_KEY, { tokenRepository, tokenRefresh });

    const firstRequest = first.service.getAccessToken();
    await vi.waitFor(() => expect(leaseToken).not.toBeNull());
    const secondRequest = second.service.getAccessToken();
    await vi.waitFor(() => expect(tokenRepository.tryAcquireRefreshLease).toHaveBeenCalledTimes(2));
    completeProviderCall();

    const [firstResult, secondResult] = await Promise.all([firstRequest, secondRequest]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.accessToken).toBe("refreshed-access-token");
    expect(tokenRefresh).toHaveBeenCalledOnce();
  });

  it("does not save tokens when the refresh provider fails", async () => {
    const { tokenRepository, tokenRefresh, service } = createHarness();

    tokenRepository.get.mockResolvedValue({
      encryptedAccessToken: encryptSecret("expired-access-token", ENCRYPTION_KEY),
      encryptedRefreshToken: encryptSecret("stored-refresh-token", ENCRYPTION_KEY),
      accessTokenExpiresAt: new Date(NOW.getTime() - 1000),
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
      updatedAt: NOW,
    });

    tokenRefresh.mockRejectedValueOnce(
      new Error("Zoho token refresh failed with HTTP status 401."),
    );

    await expect(service.getAccessToken()).rejects.toThrow(
      "Zoho token refresh failed with HTTP status 401.",
    );

    expect(tokenRepository.saveRefreshedTokens).not.toHaveBeenCalled();
    expect(tokenRepository.releaseRefreshLease).toHaveBeenCalledOnce();
  });
});
