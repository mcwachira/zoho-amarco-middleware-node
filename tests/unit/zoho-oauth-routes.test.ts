import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { Writable } from "node:stream";

import type { ZohoOAuthService } from "../../src/application/zoho/zoho-oauth-service.js";
import { createApp } from "../../src/app.js";

const sensitiveValues = [
  "synthetic-oauth-code",
  "synthetic-oauth-state",
  "synthetic-pkce-verifier",
  "synthetic-access-token",
  "synthetic-refresh-token",
  "synthetic-client-secret",
  "synthetic-bearer-token",
  "synthetic-cookie-session",
  "synthetic-api-key",
  "synthetic-error-detail",
  "synthetic-query-credential",
];

function createCapturedLogger(): { logger: pino.Logger; getOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });

  return {
    logger: pino({ level: "info" }, stream),
    getOutput: () => output,
  };
}

function callbackUrl(): string {
  const query = new URLSearchParams({
    code: sensitiveValues[0]!,
    state: sensitiveValues[1]!,
    code_verifier: sensitiveValues[2]!,
    access_token: sensitiveValues[3]!,
    refresh_token: sensitiveValues[4]!,
    client_secret: sensitiveValues[5]!,
    id_token: sensitiveValues[10]!,
    password: sensitiveValues[10]!,
  });

  return `/integrations/zoho/callback?${query}`;
}

function expectSafeRequestLog(
  output: string,
  statusCode: number,
  requestPath = "/integrations/zoho/callback",
): void {
  for (const value of sensitiveValues) {
    expect(output).not.toContain(value);
  }

  const entries = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const requestEntry = entries.find((entry) => {
    const req = entry["req"];
    const res = entry["res"];
    return (
      typeof req === "object" &&
      req !== null &&
      "method" in req &&
      typeof res === "object" &&
      res !== null
    );
  });

  expect(requestEntry).toBeDefined();
  const req = requestEntry!["req"] as Record<string, unknown>;
  const res = requestEntry!["res"] as Record<string, unknown>;

  expect(req["method"]).toBe("GET");
  expect(req["url"]).toBe(requestPath);
  expect(req["id"]).toBeDefined();
  expect(req).not.toHaveProperty("headers");
  expect(res["statusCode"]).toBe(statusCode);
  expect(typeof requestEntry!["responseTime"]).toBe("number");
}

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

    expect(JSON.stringify(response.body)).not.toContain("Sensitive OAuth state storage details");

    expect(oauthService.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it("omits OAuth callback secrets from successful request logs", async () => {
    const oauthService = createOAuthServiceMock();
    const captured = createCapturedLogger();
    const app = createApp({ oauthService, requestLogger: captured.logger });

    const requestWithCredentials = request(app)
      .get(callbackUrl())
      .set("Cookie", `session=${sensitiveValues[7]}`)
      .set("X-Api-Key", sensitiveValues[8]!);
    const response = await requestWithCredentials.set(
      "Authorization",
      `Bearer ${sensitiveValues[6]}`,
    );

    expect(response.status).toBe(200);
    expectSafeRequestLog(captured.getOutput(), 200);
  });

  it("omits OAuth callback secrets from rejected callback request logs", async () => {
    const oauthService = createOAuthServiceMock();
    vi.mocked(oauthService.consumeCallbackState).mockResolvedValue(null);
    const captured = createCapturedLogger();
    const app = createApp({ oauthService, requestLogger: captured.logger });

    const response = await request(app)
      .get(callbackUrl())
      .set("Cookie", `session=${sensitiveValues[7]}`)
      .set("X-Api-Key", sensitiveValues[8]!)
      .set("Authorization", `Bearer ${sensitiveValues[6]}`);

    expect(response.status).toBe(400);
    expectSafeRequestLog(captured.getOutput(), 400);
  });

  it("omits OAuth callback secrets and exception details from error logs", async () => {
    const oauthService = createOAuthServiceMock();
    vi.mocked(oauthService.exchangeAuthorizationCode).mockRejectedValue(
      new Error(sensitiveValues.join(" ")),
    );
    const captured = createCapturedLogger();
    const app = createApp({ oauthService, requestLogger: captured.logger });

    const response = await request(app)
      .get(callbackUrl())
      .set("Authorization", `Bearer ${sensitiveValues[6]}`);

    expect(response.status).toBe(500);
    expectSafeRequestLog(captured.getOutput(), 500);
  });

  it("does not log OAuth redirect credentials from response headers", async () => {
    const oauthService = createOAuthServiceMock();
    vi.mocked(oauthService.startAuthorization).mockResolvedValue({
      authorizationUrl:
        `https://accounts.zoho.com/oauth/v2/auth?state=${sensitiveValues[1]}` +
        `&code_challenge=${sensitiveValues[2]}`,
    });
    const captured = createCapturedLogger();
    const app = createApp({ oauthService, requestLogger: captured.logger });

    const response = await request(app).get("/integrations/zoho/authorize");

    expect(response.status).toBe(302);
    expect(response.headers["location"]).toContain(sensitiveValues[1]);
    expectSafeRequestLog(captured.getOutput(), 302, "/integrations/zoho/authorize");
  });

  it("keeps normal request diagnostics while omitting arbitrary query strings", async () => {
    const captured = createCapturedLogger();
    const app = createApp({ requestLogger: captured.logger });

    const response = await request(app).get(`/health/live?probe=${sensitiveValues[10]}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expectSafeRequestLog(captured.getOutput(), 200, "/health/live");
  });

  it("omits arbitrary multi-parameter queries from HTTP error logs", async () => {
    const captured = createCapturedLogger();
    const app = createApp({ requestLogger: captured.logger });

    const response = await request(app).get(
      `/missing?first=${sensitiveValues[10]}&second=${sensitiveValues[7]}&third=${sensitiveValues[8]}`,
    );

    expect(response.status).toBe(404);
    expectSafeRequestLog(captured.getOutput(), 404, "/missing");
  });

  it("omits unusual malformed query encoding from request logs", async () => {
    const captured = createCapturedLogger();
    const app = createApp({ requestLogger: captured.logger });

    const response = await request(app).get(
      `/health/live?malformed=%ZZ&opaque=${sensitiveValues[10]}`,
    );

    expect(response.status).toBe(200);
    expectSafeRequestLog(captured.getOutput(), 200, "/health/live");
  });
});
