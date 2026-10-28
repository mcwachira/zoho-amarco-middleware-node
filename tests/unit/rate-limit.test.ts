import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRateLimitMiddleware } from "../../src/middleware/rate-limit.js";

function createApp(options: Parameters<typeof createRateLimitMiddleware>[0]) {
  const app = express();
  app.use(createRateLimitMiddleware(options));
  app.get("/resource", (_request, response) => response.status(200).json({ ok: true }));
  return app;
}

describe("request rate limit middleware", () => {
  it("allows the configured request count and returns a retry delay after the limit", async () => {
    const app = createApp({ windowMs: 10_000, maxRequests: 2, now: () => 1_000 });
    expect((await request(app).get("/resource")).status).toBe(200);
    expect((await request(app).get("/resource")).status).toBe(200);

    const limited = await request(app).get("/resource");
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
    expect(limited.headers["retry-after"]).toBe("10");
    expect(limited.headers["ratelimit-remaining"]).toBe("0");
  });

  it("resets the window and does not trust forwarded IP headers", async () => {
    let timestamp = 1_000;
    const app = createApp({
      windowMs: 1_000,
      maxRequests: 1,
      now: () => timestamp,
    });
    expect((await request(app).get("/resource").set("X-Forwarded-For", "203.0.113.1")).status).toBe(
      200,
    );
    expect((await request(app).get("/resource").set("X-Forwarded-For", "203.0.113.2")).status).toBe(
      429,
    );
    timestamp = 2_001;
    expect((await request(app).get("/resource")).status).toBe(200);
  });

  it("bounds key tracking and fails closed at capacity", async () => {
    const app = createApp({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 1,
      keyForRequest: (req) => String(req.headers["x-test-client"] ?? "first"),
    });
    expect((await request(app).get("/resource").set("X-Test-Client", "first")).status).toBe(200);
    const full = await request(app).get("/resource").set("X-Test-Client", "second");
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe("RATE_LIMIT_CAPACITY_REACHED");
  });

  it("rejects invalid limiter settings", () => {
    expect(() => createRateLimitMiddleware({ windowMs: 0, maxRequests: 1 })).toThrow();
    expect(() => createRateLimitMiddleware({ windowMs: 1_000, maxRequests: 0 })).toThrow();
  });
});
