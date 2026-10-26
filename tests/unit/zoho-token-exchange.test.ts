import { describe, expect, it, vi } from "vitest";
import {
  exchangeZohoAuthorizationCode,
  refreshZohoAccessToken,
  type ZohoTokenExchangeTransport,
} from "../../src/integrations/zoho/token-exchange.js";

describe("exchangeZohoAuthorizationCode", () => {
  it("sends the authorization code and PKCE verifier to Zoho", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com",
          scope: "ZohoBooks.invoices.READ",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await exchangeZohoAuthorizationCode(
      {
        accountsUrl: "https://accounts.zoho.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        redirectUri: "https://example.com/integrations/zoho/callback",
        code: "test-authorization-code",
        codeVerifier: "test-code-verifier",
      },
      transport,
    );

    expect(transport).toHaveBeenCalledOnce();

    const [url, request] = transport.mock.calls[0]!;

    expect(String(url)).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(request?.method).toBe("POST");

    const body = new URLSearchParams(request?.body as string);

    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe("https://example.com/integrations/zoho/callback");
    expect(body.get("code")).toBe("test-authorization-code");
    expect(body.get("code_verifier")).toBe("test-code-verifier");

    expect(result).toEqual({
      accessToken: "test-access-token",
      refreshToken: "test-refresh-token",
      expiresIn: 3600,
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });
  });

  it("rejects an untrusted Accounts hostname without making a request", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://attacker.example",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho Accounts URL must be an official HTTPS endpoint.");

    expect(transport).not.toHaveBeenCalled();
  });

  it("does not expose the response body when Zoho rejects the exchange", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_code",
          client_secret: "sensitive-test-secret",
        }),
        { status: 400 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "sensitive-test-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "invalid-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token exchange failed with HTTP status 400.");

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "sensitive-test-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "invalid-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.not.toThrow("sensitive-test-secret");

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed JSON from Zoho", async () => {
    const transport = vi
      .fn<ZohoTokenExchangeTransport>()
      .mockResolvedValue(new Response("not-json", { status: 200 }));

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho returned an invalid JSON token response.");
  });

  it("rejects a successful HTTP response with a missing access token", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com",
          scope: "ZohoBooks.invoices.READ",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response is missing a valid access token.");
  });

  it("rejects an Accounts URL that does not use HTTPS", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "http://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho Accounts URL must use HTTPS.");

    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an Accounts URL containing embedded credentials", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://user:password@accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho Accounts URL must not contain credentials.");

    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an API domain that does not use HTTPS", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "http://www.zohoapis.com",
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response contains an invalid API domain.");
  });

  it("rejects an API domain containing a path", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com/untrusted-path",
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response contains an invalid API domain.");
  });

  it("rejects an invalid token expiry", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: -1,
          api_domain: "https://www.zohoapis.com",
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response contains an invalid expiry.");
  });

  it("rejects a token response missing the API domain", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response is missing a valid API domain.");
  });

  it("rejects a token response missing scopes", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response is missing valid scopes.");
  });

  it("rejects an API domain outside the trusted Zoho Books hosts", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          api_domain: "https://attacker.example",
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    await expect(
      exchangeZohoAuthorizationCode(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          redirectUri: "https://example.com/integrations/zoho/callback",
          code: "test-authorization-code",
          codeVerifier: "test-code-verifier",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token response contains an invalid API domain.");
  });
});

describe("refreshZohoAccessToken", () => {
  it("sends a refresh-token grant and validates the response", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com",
          scope: "ZohoBooks.invoices.READ",
        }),
        { status: 200 },
      ),
    );

    const result = await refreshZohoAccessToken(
      {
        accountsUrl: "https://accounts.zoho.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      },
      transport,
    );

    expect(transport).toHaveBeenCalledOnce();

    const [url, request] = transport.mock.calls[0]!;

    expect(String(url)).toBe("https://accounts.zoho.com/oauth/v2/token");
    expect(request?.method).toBe("POST");

    const body = new URLSearchParams(request?.body as string);

    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("refresh_token")).toBe("test-refresh-token");

    expect(result).toEqual({
      accessToken: "new-access-token",
      expiresIn: 3600,
      apiDomain: "https://www.zohoapis.com",
      scopes: "ZohoBooks.invoices.READ",
    });
  });

  it("accepts a valid refresh response without a scope field", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          expires_in: 3600,
          api_domain: "https://www.zohoapis.com",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    );

    const result = await refreshZohoAccessToken(
      {
        accountsUrl: "https://accounts.zoho.com",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      },
      transport,
    );

    expect(result.accessToken).toBe("new-access-token");
    expect(result.expiresIn).toBe(3600);
    expect(result.apiDomain).toBe("https://www.zohoapis.com");
    expect(result.scopes).toBeUndefined();
  });

  it("rejects non-HTTPS Accounts URLs without making a request", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      refreshZohoAccessToken(
        {
          accountsUrl: "http://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          refreshToken: "test-refresh-token",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho Accounts URL must use HTTPS.");

    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects missing refresh tokens without making a request", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      refreshZohoAccessToken(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          refreshToken: " ",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho client credentials and refresh token are required.");

    expect(transport).not.toHaveBeenCalled();
  });

  it("does not expose the provider response body on failure", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_code",
          refresh_token: "sensitive-test-token",
        }),
        { status: 400 },
      ),
    );

    await expect(
      refreshZohoAccessToken(
        {
          accountsUrl: "https://accounts.zoho.com",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          refreshToken: "sensitive-test-token",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho token refresh failed with HTTP status 400.");
  });

  it("rejects an untrusted Accounts hostname without making a request", async () => {
    const transport = vi.fn<ZohoTokenExchangeTransport>();

    await expect(
      refreshZohoAccessToken(
        {
          accountsUrl: "https://attacker.example",
          clientId: "test-client-id",
          clientSecret: "test-client-secret",
          refreshToken: "test-refresh-token",
        },
        transport,
      ),
    ).rejects.toThrow("Zoho Accounts URL must be an official HTTPS endpoint.");

    expect(transport).not.toHaveBeenCalled();
  });
});
