import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { requireInvoiceApiToken } from "../../src/middleware/require-invoice-api-token.js";

function createApp(token: string | undefined) {
  const app = express();

  app.get("/protected", requireInvoiceApiToken(token), (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  return app;
}

describe("requireInvoiceApiToken", () => {
  const validToken = "test-token-".repeat(6);

  it("allows a request with the correct bearer token", async () => {
    const response = await request(createApp(validToken))
      .get("/protected")
      .set("Authorization", `Bearer ${validToken}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("rejects a request without an authorization header", async () => {
    const response = await request(createApp(validToken)).get("/protected");

    expect(response.status).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an incorrect bearer token without exposing either token", async () => {
    const incorrectToken = "wrong-token";
    const response = await request(createApp(validToken))
      .get("/protected")
      .set("Authorization", `Bearer ${incorrectToken}`);

    expect(response.status).toBe(401);
    expect(JSON.stringify(response.body)).not.toContain(validToken);
    expect(JSON.stringify(response.body)).not.toContain(incorrectToken);
  });

  it("rejects malformed authorization headers", async () => {
    const response = await request(createApp(validToken))
      .get("/protected")
      .set("Authorization", `Basic ${validToken}`);

    expect(response.status).toBe(401);
  });

  it("fails closed when authentication is not configured", async () => {
    const response = await request(createApp(undefined))
      .get("/protected")
      .set("Authorization", `Bearer ${validToken}`);

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("INVOICE_API_AUTH_UNAVAILABLE");
  });

  it("does not call the protected route handler when the token is invalid", async () => {
    const protectedHandler = vi.fn((_req, res) => {
      res.status(200).json({ status: "ok" });
    });

    const app = express();

    app.get("/protected", requireInvoiceApiToken(validToken), protectedHandler);

    const response = await request(app).get("/protected").set("Authorization", "Bearer incorrect");

    expect(response.status).toBe(401);
    expect(protectedHandler).not.toHaveBeenCalled();
  });
});
