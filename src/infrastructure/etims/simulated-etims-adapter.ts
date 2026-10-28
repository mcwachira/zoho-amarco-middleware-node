import type {
  EtimsAdapterReconciliationResult,
  EtimsAdapterStatus,
  EtimsAdapterSubmissionResult,
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "../../application/fiscalization/etims-reporting-adapter.js";

export type SimulatedEtimsScenario =
  "accepted" | "rejected" | "timeout" | "uncertain" | "exception" | "unavailable";

/** Test/development-only adapter. It never creates or returns real KRA evidence. */
export class SimulatedEtimsAdapter implements EtimsReportingAdapter {
  readonly status: EtimsAdapterStatus;
  private readonly submissions: PreparedEtimsReportingRequest[] = [];

  constructor(readonly scenario: SimulatedEtimsScenario = "accepted") {
    this.status = {
      adapterType: "vscu",
      configured: true,
      contractVerified: true,
      operational: scenario !== "unavailable",
      configurationId: `simulation:${scenario}`,
      simulated: true,
      blockers: ["simulated_adapter_only"],
      capabilities: {
        supportsReconciliation: false,
        safeResubmissionAfterConfirmedNotFound: false,
      },
    };
  }

  getSubmissionCount(): number {
    return this.submissions.length;
  }

  async validate(): Promise<readonly string[]> {
    return this.scenario === "unavailable" ? ["simulated_service_unavailable"] : [];
  }

  async submit(request: PreparedEtimsReportingRequest): Promise<EtimsAdapterSubmissionResult> {
    this.submissions.push(request);
    switch (this.scenario) {
      case "accepted":
        return {
          kind: "accepted",
          providerReference: null,
          safeMetadataJson: JSON.stringify({ simulated: true, scenario: this.scenario }),
        };
      case "rejected":
        return {
          kind: "rejected",
          errorCategory: "simulated_rejection",
          safeMessage: "The simulated KRA adapter rejected this request.",
          providerReference: null,
          safeMetadataJson: JSON.stringify({ simulated: true, scenario: this.scenario }),
        };
      case "timeout":
      case "uncertain":
        return {
          kind: "outcome_unknown",
          errorCategory: `simulated_${this.scenario}`,
          safeMessage: `Simulated KRA ${this.scenario}; remote acceptance is unknown.`,
        };
      case "exception":
        throw new Error("Simulated KRA adapter exception.");
      case "unavailable":
        return {
          kind: "not_submitted",
          errorCategory: "simulated_service_unavailable",
          safeMessage: "The simulated KRA adapter is unavailable; no request was sent.",
        };
    }
  }

  async reconcile(): Promise<EtimsAdapterReconciliationResult> {
    return {
      kind: "outcome_unknown",
      safeMessage: "Simulated KRA reconciliation is unsupported; manual review is required.",
    };
  }
}
