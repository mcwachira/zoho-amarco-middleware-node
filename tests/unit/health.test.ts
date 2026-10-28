import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { OperationalMetrics } from "../../src/observability/operational-metrics.js";

describe("Health endpoints", () => {
  it("reports disabled integrations without claiming live verification", async () => {
    const app = createApp();
    const response = await request(app).get("/health/integrations");

    expect(response.status).toBe(200);
    expect(response.body.zohoBooks).toBe("not_configured");
    expect(response.body.device.receiptIssuance).toBe("disabled");
    expect(response.body.etims).toMatchObject({ enabled: false, status: "not_configured" });
    expect(response.body.etims.providerHealth).toBe("unverified");
    expect(response.body.etims.reconciliationWorker).toMatchObject({
      enabled: false,
      started: false,
      reason: "worker_not_registered",
    });
    expect(response.body.combinedWorkflow).toEqual({
      status: "blocked",
      blockers: ["legal_sequence_unverified"],
    });
    expect(JSON.stringify(response.body)).not.toMatch(/password|secret|token/i);
  });

  it("exposes selected KRA protocol configuration without probing or approving the provider", async () => {
    const readiness = vi.fn().mockReturnValue({
      mode: "vscu",
      environment: "local-service",
      configured: true,
      configurationValid: true,
      transportReady: "not_checked",
      contractTests: "implemented_not_provider_verified",
      contractVerified: false,
      sandboxVerified: false,
      providerApproved: false,
      liveOperationPermitted: false,
      supportedOperations: ["initialize", "save_sales"],
      reconciliationVerified: false,
      blockers: ["official_vscu_package_installation_unverified"],
    });
    const response = await request(createApp({ etimsProtocolReadiness: readiness })).get(
      "/health/integrations",
    );
    expect(response.status).toBe(200);
    expect(response.body.etims.protocol).toMatchObject({
      mode: "vscu",
      configured: true,
      configurationValid: true,
      transportReady: "not_checked",
      contractTests: "implemented_not_provider_verified",
      contractVerified: false,
      sandboxVerified: false,
      providerApproved: false,
      liveOperationPermitted: false,
      reconciliationVerified: false,
    });
    expect(response.body.etims.providerHealth).toBe("unverified");
    expect(readiness).toHaveBeenCalledOnce();
  });

  it("reports that the process is alive", async () => {
    const app = createApp();
    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("records request status and latency with fixed metric labels", async () => {
    const metrics = new OperationalMetrics();
    const response = await request(createApp({ metrics })).get("/health/live");
    expect(response.status).toBe(200);
    expect(metrics.snapshot().counters["http_requests.2xx"]).toBe(1);
    expect(metrics.snapshot().httpDurationMs.count).toBe(1);
  });

  it("echoes a safe correlation ID and replaces unsafe values", async () => {
    const app = createApp();
    const supplied = await request(app)
      .get("/health/live")
      .set("X-Correlation-ID", "operator-check:42");
    expect(supplied.headers["x-correlation-id"]).toBe("operator-check:42");

    const unsafe = await request(app)
      .get("/health/live")
      .set("X-Correlation-ID", "token=secret value");
    expect(unsafe.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const missing = await request(app).get("/health/live");
    expect(missing.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const oversized = await request(app)
      .get("/health/live")
      .set("X-Correlation-ID", "c".repeat(129));
    expect(oversized.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
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

  it("bounds a stalled database readiness check while keeping liveness available", async () => {
    const checkDatabaseConnection = vi.fn(() => new Promise<void>(() => {}));
    const app = createApp({ checkDatabaseConnection, databaseReadinessTimeoutMs: 20 });

    const readiness = await request(app).get("/health/ready");
    const liveness = await request(app).get("/health/live");

    expect(readiness.status).toBe(503);
    expect(readiness.body).toEqual({ status: "not_ready" });
    expect(liveness.status).toBe(200);
    expect(liveness.body).toEqual({ status: "ok" });
    expect(checkDatabaseConnection).toHaveBeenCalledOnce();
  });

  it("rejects an invalid injected database readiness timeout", () => {
    expect(() => createApp({ databaseReadinessTimeoutMs: 0 })).toThrow(
      "Database readiness timeout must be a positive integer.",
    );
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

  it("bounds a stalled device health probe and does not affect process liveness", async () => {
    const app = createApp({
      dependencyHealthTimeoutMs: 20,
      fiscalDeviceDiagnostics: { checkConnection: vi.fn(() => new Promise<never>(() => {})) },
    });
    const start = performance.now();
    const response = await request(app).get("/health/device");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: "unavailable",
      component: "device",
      reason: "timeout",
    });
    expect(performance.now() - start).toBeLessThan(1_000);
    expect((await request(app).get("/health/live")).status).toBe(200);
  });

  it("reports required and optional dependency diagnostics without probing provider operations", async () => {
    const checkDatabaseConnection = vi.fn().mockResolvedValue(undefined);
    const device = {
      checkConnection: vi
        .fn()
        .mockResolvedValue({ status: "unavailable", reason: "TransportError" }),
    };
    const etimsReadiness = vi.fn().mockReturnValue({ enabled: false });
    const response = await request(
      createApp({
        checkDatabaseConnection,
        fiscalDeviceDiagnostics: device,
        etimsReportingService: { getReadiness: etimsReadiness } as never,
        booksClient: {} as never,
      }),
    ).get("/health/dependencies");
    expect(response.status).toBe(200);
    expect(response.body.dependencies).toEqual({
      database: "available",
      device: "unavailable",
      zohoBooks: "configured_unverified",
      etims: "not_configured",
    });
    expect(device.checkConnection).toHaveBeenCalledOnce();
    expect(etimsReadiness).toHaveBeenCalledOnce();
  });

  it("rejects non-positive dependency diagnostic timeouts", () => {
    expect(() => createApp({ dependencyHealthTimeoutMs: 0 })).toThrow(
      "Dependency health timeout must be a positive integer.",
    );
  });

  it("rejects mutating API work after shutdown starts", async () => {
    const response = await request(
      createApp({
        invoiceApiBearerToken: "service-token-that-is-distinct-and-32-chars",
        isShuttingDown: () => true,
      }),
    )
      .post("/integrations/zoho/fiscalization-requests/request-1/process")
      .set("Authorization", "Bearer service-token-that-is-distinct-and-32-chars");
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("SERVER_SHUTTING_DOWN");
    expect(response.headers["retry-after"]).toBe("5");
  });
});
