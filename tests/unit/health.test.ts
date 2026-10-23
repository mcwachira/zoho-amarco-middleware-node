import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";

describe("Health endpoints", () => {
  it("reports that the process is alive", async () => {
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports that the application is ready", async () => {
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
  });

  it("returns a consistent response for unknown routes", async () => {
    const response = await request(app).get("/route-that-does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("includes security headers", async () => {
    const response = await request(app).get("/health/live");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});
