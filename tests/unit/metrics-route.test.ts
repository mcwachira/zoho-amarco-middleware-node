import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { OperationalMetrics } from "../../src/observability/operational-metrics.js";

describe("operator metrics endpoint", () => {
  it("is private and returns low-cardinality counters and job health", async () => {
    const metrics = new OperationalMetrics();
    metrics.increment("device_attempts", "uncertain");
    const app = createApp({
      invoiceApiBearerToken: "service-token-that-is-distinct-and-32-chars",
      operatorApiBearerToken: "operator-token-that-is-distinct-and-long-enough",
      metrics,
    });
    expect((await request(app).get("/integrations/zoho/operations/metrics")).status).toBe(401);
    expect(
      (
        await request(app)
          .get("/integrations/zoho/operations/metrics")
          .set("Authorization", "Bearer service-token-that-is-distinct-and-32-chars")
      ).status,
    ).toBe(403);
    const response = await request(app)
      .get("/integrations/zoho/operations/metrics")
      .set("Authorization", "Bearer operator-token-that-is-distinct-and-long-enough");
    expect(response.status).toBe(200);
    expect(response.body.counters["device_attempts.uncertain"]).toBe(1);
  });
});
