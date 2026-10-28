import { describe, expect, it } from "vitest";
import type {
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "../../src/application/fiscalization/etims-reporting-adapter.js";
import { SimulatedEtimsAdapter } from "../../src/infrastructure/etims/simulated-etims-adapter.js";

const request: PreparedEtimsReportingRequest = {
  operationId: "operation-1",
  fiscalizationRequestId: "request-1",
  zohoInvoiceId: "invoice-1",
  correlationId: "correlation-1",
  payloadHash: "a".repeat(64),
  payload: { simulated: true },
};

describe("SimulatedEtimsAdapter", () => {
  it.each(["accepted", "rejected"] as const)(
    "marks %s as simulated and emits no provider evidence",
    async (scenario) => {
      const adapter = new SimulatedEtimsAdapter(scenario);
      const result = await adapter.submit(request);
      expect(result.kind).toBe(scenario);
      if (result.kind === "accepted" || result.kind === "rejected") {
        expect(result.providerReference).toBeNull();
        expect(JSON.parse(result.safeMetadataJson ?? "{}")).toEqual({ simulated: true, scenario });
      }
    },
  );

  it.each(["timeout", "uncertain"] as const)(
    "treats %s as unknown and reconciliation stays unknown",
    async (scenario) => {
      const adapter = new SimulatedEtimsAdapter(scenario);
      const contract: EtimsReportingAdapter = adapter;
      expect(await contract.submit(request)).toMatchObject({ kind: "outcome_unknown" });
      expect(await contract.reconcile(request)).toMatchObject({ kind: "outcome_unknown" });
    },
  );

  it("distinguishes an unavailable adapter before submission", async () => {
    const adapter = new SimulatedEtimsAdapter("unavailable");
    const contract: EtimsReportingAdapter = adapter;
    expect(adapter.status.operational).toBe(false);
    expect(await contract.validate(request)).toContain("simulated_service_unavailable");
    expect(await adapter.submit(request)).toMatchObject({ kind: "not_submitted" });
    expect(adapter.getSubmissionCount()).toBe(1);
  });

  it("surfaces configured adapter exceptions without disguising them as accepted", async () => {
    const adapter = new SimulatedEtimsAdapter("exception");
    await expect(adapter.submit(request)).rejects.toThrow("Simulated KRA adapter exception.");
  });
});
