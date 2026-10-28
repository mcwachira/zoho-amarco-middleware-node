import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

describe("operator reconciliation HTTP routes", () => {
  const reviewCase = {
    id: "case-1",
    fiscalizationRequestId: "request-1",
    operationId: "operation-1",
    relatedAttemptIds: ["attempt-1"],
    observedState: "OutcomeUnknown",
    reason: "timeout",
    status: "open",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    decisions: [],
  };
  const service = {
    open: vi.fn(async () => reviewCase),
    get: vi.fn(async () => reviewCase),
    getByRequestId: vi.fn(async () => reviewCase),
    listUnresolved: vi.fn(async () => [reviewCase]),
    decide: vi.fn(async () => ({
      ...reviewCase,
      decisions: [{ operatorSubject: "configured-operator" }],
    })),
  };
  const app = () =>
    createApp({
      invoiceApiBearerToken: "service-token",
      operatorApiBearerToken: "operator-token",
      manualReviewService: service as never,
    });

  it("requires the dedicated operator permission", async () => {
    const response = await request(app())
      .get("/integrations/zoho/manual-review")
      .set("Authorization", "Bearer service-token");
    expect(response.status).toBe(403);
  });

  it("authenticates and lists bounded unresolved cases", async () => {
    expect((await request(app()).get("/integrations/zoho/manual-review")).status).toBe(401);
    const response = await request(app())
      .get("/integrations/zoho/manual-review?limit=25&offset=0")
      .set("Authorization", "Bearer operator-token");
    expect(response.status).toBe(200);
    expect(response.body.cases).toHaveLength(1);
    expect(service.listUnresolved).toHaveBeenCalledWith(25, 0);
  });

  it("records the authenticated identity when opening a case", async () => {
    const response = await request(app())
      .post("/integrations/zoho/fiscalization-requests/request-1/manual-review")
      .set("Authorization", "Bearer operator-token")
      .send({ stage: "device", reason: "uncertain device response" });
    expect(response.status).toBe(201);
    expect(service.open).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSubject: "configured-operator" }),
    );
  });

  it("persists the configured named operator subject in reconciliation actions", async () => {
    const namedApp = createApp({
      invoiceApiBearerToken: "service-token",
      operatorApiCredentials: [
        {
          subject: "ops.reviewer-12",
          token: "named-operator-token-with-at-least-32-characters",
          permissions: ["invoice:read", "manual-review:decide"],
        },
      ],
      manualReviewService: service as never,
    });
    const response = await request(namedApp)
      .post("/integrations/zoho/fiscalization-requests/request-1/manual-review")
      .set("Authorization", "Bearer named-operator-token-with-at-least-32-characters")
      .send({ stage: "device", reason: "investigating uncertain result" });
    expect(response.status).toBe(201);
    expect(service.open).toHaveBeenCalledWith(
      expect.objectContaining({ operatorSubject: "ops.reviewer-12" }),
    );
  });

  it("rejects arbitrary fiscal fields and attributes decisions to the authenticated identity", async () => {
    const invalid = await request(app())
      .post("/integrations/zoho/manual-review/case-1/decisions")
      .set("Authorization", "Bearer operator-token")
      .send({ requestedOutcome: "confirmed_success", reason: "verified", receiptNumber: "forged" });
    expect(invalid.status).toBe(400);
    const valid = await request(app())
      .post("/integrations/zoho/manual-review/case-1/decisions")
      .set("Authorization", "Bearer operator-token")
      .send({
        requestedOutcome: "investigation_note",
        reason: "provider contacted",
        evidenceReference: "ticket-42",
      });
    expect(valid.status).toBe(200);
    expect(service.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorSubject: "configured-operator",
        requestedOutcome: "investigation_note",
      }),
    );
  });
});
