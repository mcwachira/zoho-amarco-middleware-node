import { describe, expect, it, vi } from "vitest";
import request from "supertest";

import type { ZohoOAuthService } from "../../src/application/zoho/zoho-oauth-service.js";
import { createApp } from "../../src/app.js";

function createOAuthServiceMock() {
  return {
    startAuthorization: vi.fn().mockResolvedValue({
      authorizationUrl: "https://accounts.zoho.com/oauth/v2/auth?client_id=test-client",
    }),
    consumeCallbackState: vi.fn().mockResolvedValue({
      codeVerifier: "test-code-verifier",
    }),
    exchangeAuthorizationCode: vi.fn().mockResolvedValue(undefined),
  } as unknown as ZohoOAuthService;
}

describe("Zoho OAuth routes", () => {
  it("returns 503 when OAuth is not configured", async () => {
    const app = createApp();

    const response = await request(app).get("/integrations/zoho/authorize");

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ZOHO_OAUTH_UNAVAILABLE");
  });

  it("redirects to the authorization URL", async () => {
    const oauthService = createOAuthServiceMock();
    const app = createApp({ oauthService });

    const response = await request(app).get("/integrations/zoho/authorize");

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toBe(
      "https://accounts.zoho.com/oauth/v2/auth?client_id=test-client",
    );
    expect(oauthService.startAuthorization).toHaveBeenCalledOnce();
  });

  it("rejects an invalid or expired OAuth state", async () => {
    const oauthService = createOAuthServiceMock();
    vi.mocked(oauthService.consumeCallbackState).mockResolvedValue(null);

    const app = createApp({ oauthService });
    const response = await request(app).get(
      "/integrations/zoho/callback?state=invalid&code=test-code",
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_OAUTH_STATE");
    expect(oauthService.consumeCallbackState).toHaveBeenCalledWith("invalid");
  });

  it("rejects authorization denial after consuming valid state", async () => {
    const oauthService = createOAuthServiceMock();
    const app = createApp({ oauthService });

    const response = await request(app).get(
      "/integrations/zoho/callback?state=valid-state&error=access_denied",
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("ZOHO_AUTHORIZATION_DENIED");
    expect(oauthService.consumeCallbackState).toHaveBeenCalledWith("valid-state");
  });

  it("rejects a callback without an authorization code", async () => {
    const oauthService = createOAuthServiceMock();
    const app = createApp({ oauthService });

    const response = await request(app).get("/integrations/zoho/callback?state=valid-state");

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("INVALID_OAUTH_CALLBACK");
  });

  it("exchanges the authorization code after consuming valid state", async () => {
    const oauthService = createOAuthServiceMock();
    const app = createApp({ oauthService });

    const response = await request(app).get(
      "/integrations/zoho/callback?state=valid-state&code=test-code",
    );

    expect(response.status).toBe(200);
    expect(response.body.message).toBe("Zoho OAuth authorization completed successfully.");

    expect(oauthService.consumeCallbackState).toHaveBeenCalledWith("valid-state");
    expect(oauthService.exchangeAuthorizationCode).toHaveBeenCalledWith(
      "test-code",
      "test-code-verifier",
    );

    expect(response.body).not.toHaveProperty("accessToken");
    expect(response.body).not.toHaveProperty("refreshToken");
  });

  it("rejects a replayed OAuth callback", async () => {
    const oauthService = createOAuthServiceMock();

    // Simulate single-use state: the first callback consumes it;
    // subsequent callbacks with the same state are rejected.
    vi.mocked(oauthService.consumeCallbackState)
      .mockResolvedValueOnce({ codeVerifier: "test-code-verifier" })
      .mockResolvedValueOnce(null);

    const app = createApp({ oauthService });
    const callbackUrl = "/integrations/zoho/callback?state=valid-state&code=test-code";

    const firstResponse = await request(app).get(callbackUrl);
    const secondResponse = await request(app).get(callbackUrl);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(400);
    expect(secondResponse.body.error.code).toBe("INVALID_OAUTH_STATE");

    expect(oauthService.exchangeAuthorizationCode).toHaveBeenCalledOnce();
  });

  it("returns 503 for the callback when OAuth is not configured", async () => {
    const app = createApp();

    const response = await request(app).get(
      "/integrations/zoho/callback?state=some-state&code=test-code",
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("ZOHO_OAUTH_UNAVAILABLE");
  });

  it("returns a generic 500 when token exchange fails", async () => {
    const oauthService = createOAuthServiceMock();

    vi.mocked(oauthService.exchangeAuthorizationCode).mockRejectedValue(
      new Error("Sensitive Zoho token exchange details"),
    );

    const app = createApp({ oauthService });

    const response = await request(app).get(
      "/integrations/zoho/callback?state=valid-state&code=test-code",
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(response.body.error.message).toBe("An unexpected error occurred.");

    expect(JSON.stringify(response.body)).not.toContain("Sensitive Zoho token exchange details");

    expect(oauthService.exchangeAuthorizationCode).toHaveBeenCalledWith(
      "test-code",
      "test-code-verifier",
    );
  });

  it("returns a generic 500 when consuming OAuth state fails", async () => {
    const oauthService = createOAuthServiceMock();

    vi.mocked(oauthService.consumeCallbackState).mockRejectedValue(
      new Error("Sensitive OAuth state storage details"),
    );

    const app = createApp({ oauthService });

    const response = await request(app).get(
      "/integrations/zoho/callback?state=valid-state&code=test-code",
    );

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(response.body.error.message).toBe("An unexpected error occurred.");

    expect(JSON.stringify(response.body)).not.toContain(
      "Sensitive OAuth state storage details",
    );

    expect(oauthService.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

});
