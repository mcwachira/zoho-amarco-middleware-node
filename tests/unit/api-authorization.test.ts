import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { authenticateApiToken, requirePermission } from "../../src/middleware/api-authorization.js";

describe("API role and permission boundary", () => {
  const serviceToken = "service-token-with-at-least-32-characters";
  const operatorToken = "operator-token-is-different-and-also-long-enough";
  function app() {
    const server = express();
    server.use(authenticateApiToken(serviceToken, operatorToken));
    server.post("/requests", requirePermission("request:create"), (_req, res) =>
      res.sendStatus(201),
    );
    server.get("/history", requirePermission("request:read"), (_req, res) => res.sendStatus(200));
    server.post("/reconcile", requirePermission("etims:reconcile"), (_req, res) =>
      res.sendStatus(200),
    );
    return server;
  }

  it("rejects missing and malformed credentials", async () => {
    expect((await request(app()).get("/history")).status).toBe(401);
    expect((await request(app()).get("/history").set("Authorization", "Bearer a b")).status).toBe(
      401,
    );
  });

  it("fails closed if the same credential is configured for both roles", async () => {
    const server = express();
    server.use(authenticateApiToken(serviceToken, serviceToken));
    server.get("/protected", (_req, res) => res.sendStatus(200));
    expect(
      (await request(server).get("/protected").set("Authorization", `Bearer ${serviceToken}`))
        .status,
    ).toBe(503);
  });

  it("allows service identities only the least-privilege permissions", async () => {
    expect(
      (await request(app()).post("/requests").set("Authorization", `Bearer ${serviceToken}`))
        .status,
    ).toBe(201);
    const denied = await request(app())
      .post("/reconcile")
      .set("Authorization", `Bearer ${serviceToken}`)
      .set("X-Role", "operator");
    expect(denied.status).toBe(403);
  });

  it("allows a configured operator token to reconcile", async () => {
    expect(
      (await request(app()).post("/reconcile").set("Authorization", `Bearer ${operatorToken}`))
        .status,
    ).toBe(200);
  });

  it("uses the named operator subject and enforces only its configured permissions", async () => {
    const namedApp = express();
    namedApp.use(
      authenticateApiToken(serviceToken, undefined, [
        {
          subject: "reconciliation.operator-7",
          token: "named-operator-token-with-at-least-32-characters",
          permissions: ["etims:reconcile"],
        },
      ]),
    );
    namedApp.post("/reconcile", requirePermission("etims:reconcile"), (_req, res) => {
      res.status(200).json({ subject: res.locals["apiIdentity"].subject });
    });
    namedApp.post("/device", requirePermission("device:operate"), (_req, res) =>
      res.sendStatus(200),
    );

    const token = "named-operator-token-with-at-least-32-characters";
    const authorized = await request(namedApp)
      .post("/reconcile")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Role", "service");
    expect(authorized.status).toBe(200);
    expect(authorized.body.subject).toBe("reconciliation.operator-7");
    expect(
      (await request(namedApp).post("/device").set("Authorization", `Bearer ${token}`)).status,
    ).toBe(403);
  });
});
