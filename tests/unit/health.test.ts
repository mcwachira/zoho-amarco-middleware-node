import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

describe("Health endpoints", () => {
  it("reports that the process is alive", async () => {
    const app = createApp();
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports that the application is ready when the database is reachable", async () => {
    const checkDatabaseConnection = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ checkDatabaseConnection });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ready" });
    expect(checkDatabaseConnection).toHaveBeenCalledOnce();
  });

  it("reports not ready when the database check fails", async () => {
    const checkDatabaseConnection = vi.fn().mockRejectedValue(new Error("Database unavailable"));
    const app = createApp({ checkDatabaseConnection });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
    expect(checkDatabaseConnection).toHaveBeenCalledOnce();
  });

  it("reports not ready when no database check is configured", async () => {
    const app = createApp();
    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: "not_ready" });
  });

  it("returns a consistent response for unknown routes", async () => {
    const app = createApp();
    const response = await request(app).get("/route-that-does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("includes security headers", async () => {
    const app = createApp();
    const response = await request(app).get("/health/live");

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("reports connected when device diagnostics succeed", async () => {
    const fiscalDeviceDiagnostics = {
      checkConnection: vi.fn().mockResolvedValue({ status: "connected" }),
    };
    const app = createApp({ fiscalDeviceDiagnostics });

    const response = await request(app).get("/health/device");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "connected",
      component: "device",
    });
    expect(fiscalDeviceDiagnostics.checkConnection).toHaveBeenCalledOnce();
  });

  it("reports unavailable when device diagnostics fail", async () => {
    const fiscalDeviceDiagnostics = {
      checkConnection: vi.fn().mockResolvedValue({
        status: "unavailable",
        reason: "TremolHttpError",
      }),
    };
    const app = createApp({ fiscalDeviceDiagnostics });

    const response = await request(app).get("/health/device");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      component: "device",
      reason: "TremolHttpError",
    });
    expect(fiscalDeviceDiagnostics.checkConnection).toHaveBeenCalledOnce();
  });

  it("reports unavailable when device diagnostics are not configured", async () => {
    const app = createApp();

    const response = await request(app).get("/health/device");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: "unavailable",
      component: "device",
    });
  });
});
