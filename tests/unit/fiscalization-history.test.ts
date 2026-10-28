import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";

const token = "history-service-token-at-least-thirty-two-characters";
const stored: FiscalizationRecord = {
  id: "request-1",
  zohoInvoiceId: "invoice-sensitive-id",
  snapshot: { schemaVersion: 1 } as FiscalizationRecord["snapshot"],
  snapshotVersion: 1,
  status: "OutcomeUnknown",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  receipt: null,
  failure: null,
  outcomeUnknownReason: "sensitive internal detail",
};

function build(repositoryOverrides: Partial<FiscalizationRepository> = {}) {
  const repository = {
    findById: vi.fn(),
    findByZohoInvoiceId: vi.fn(),
    create: vi.fn(),
    claimPending: vi.fn(),
    saveOutcome: vi.fn(),
    markStaleInProgressOutcomeUnknown: vi.fn(),
    listHistory: vi.fn(async () => ({ records: [stored], total: 1 })),
    findAttemptsByRequestId: vi.fn(async () => []),
    ...repositoryOverrides,
  } as unknown as FiscalizationRepository;
  return {
    repository,
    app: createApp({ invoiceApiBearerToken: token, fiscalizationRepository: repository }),
  };
}

describe("fiscalization history API", () => {
  it("validates page bounds and requires authentication", async () => {
    const { app } = build();
    expect(
      (
        await request(app)
          .get("/integrations/zoho/fiscalization-requests?page=0")
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get("/integrations/zoho/fiscalization-requests?pageSize=101")
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get("/integrations/zoho/fiscalization-requests?page=21474838&pageSize=100")
          .set("Authorization", `Bearer ${token}`)
      ).status,
    ).toBe(400);
    expect((await request(app).get("/integrations/zoho/fiscalization-requests")).status).toBe(401);
  });

  it("does not permit service identities to bypass privileged device or profile operations", async () => {
    const { app } = build();
    const device = await request(app)
      .post("/integrations/zoho/fiscalization-requests/request-1/process")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Role", "operator");
    const profile = await request(app)
      .post("/integrations/zoho/fiscal-item-profiles")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Role", "admin");
    const review = await request(app)
      .post("/integrations/zoho/fiscalization-requests/request-1/manual-review")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Role", "operator");
    const reconcile = await request(app)
      .post("/integrations/zoho/fiscalization-requests/request-1/etims/reconcile")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Role", "operator");
    expect(device.status).toBe(403);
    expect(profile.status).toBe(403);
    expect(review.status).toBe(403);
    expect(reconcile.status).toBe(403);
  });

  it("passes deterministic filters and returns sanitized independent outcome summaries", async () => {
    const { app, repository } = build();
    const response = await request(app)
      .get(
        "/integrations/zoho/fiscalization-requests?page=2&pageSize=10&deviceOutcome=OutcomeUnknown&etimsStatus=rejected&correlationId=sync-1&createdFrom=2026-01-01T00%3A00%3A00Z",
      )
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(repository.listHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        pageSize: 10,
        deviceOutcome: "OutcomeUnknown",
        etimsStatus: "rejected",
        correlationId: "sync-1",
      }),
    );
    expect(response.body.items[0]).toMatchObject({
      status: "OutcomeUnknown",
      deviceOutcome: "OutcomeUnknown",
      etimsOutcome: "not_configured",
    });
    expect(JSON.stringify(response.body)).not.toContain("sensitive internal detail");
    expect(response.body.items[0]).not.toHaveProperty("snapshot");
  });
});
