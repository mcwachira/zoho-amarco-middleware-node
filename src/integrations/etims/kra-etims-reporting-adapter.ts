import type {
  EtimsAdapterReconciliationResult,
  EtimsAdapterStatus,
  EtimsAdapterSubmissionResult,
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "../../application/fiscalization/etims-reporting-adapter.js";
import type { KraOscuClient } from "./kra-oscu-client.js";
import type { KraVscuClient } from "./kra-vscu-client.js";
import { KraRequestError, validateKraSalesRequest } from "./kra-protocol-client.js";
import { isKraSalesMappingOutput } from "../../application/etims/kra-sales-mapping.js";
import {
  operationalMetrics,
  safelyIncrementMetric,
} from "../../observability/operational-metrics.js";

type KraSalesClient = KraOscuClient | KraVscuClient;

/**
 * Bridges the direct KRA JSON clients to the durable application adapter
 * boundary. Contract and submission activation remain closed in production
 * until provider acceptance, taxpayer enrollment, and invoice mapping are
 * verified. The adapter itself never retries a submission.
 */
export class KraEtimsReportingAdapter implements EtimsReportingAdapter {
  readonly status: EtimsAdapterStatus;
  private readonly mode: "oscu" | "vscu";

  constructor(private readonly client: KraSalesClient) {
    const readiness = client.getReadiness();
    this.mode = readiness.mode;
    this.status = {
      adapterType: readiness.mode,
      configured: readiness.configured,
      contractVerified: false,
      operational: false,
      configurationId: `${readiness.mode}:${readiness.environment}`,
      blockers: [
        ...readiness.blockers,
        "provider_contract_acceptance_required",
        "invoice_to_kra_mapping_unverified",
        "submission_activation_closed",
      ],
      capabilities: {
        supportsReconciliation: false,
        safeResubmissionAfterConfirmedNotFound: false,
      },
    };
  }

  async validate(request: PreparedEtimsReportingRequest): Promise<readonly string[]> {
    if (!isKraSalesMappingOutput(request.payload, this.mode)) {
      return ["kraSales.mapping: Request must be produced by the versioned KRA mapping engine."];
    }
    return validateKraSalesRequest(request.payload, this.mode);
  }

  async submit(
    request: PreparedEtimsReportingRequest,
    signal?: AbortSignal,
  ): Promise<EtimsAdapterSubmissionResult> {
    if (!this.status.configured || !this.status.contractVerified || !this.status.operational) {
      return {
        kind: "not_submitted",
        errorCategory: "submission_activation_closed",
        safeMessage:
          "KRA sales submission remains disabled until provider acceptance and taxpayer readiness are verified.",
      };
    }
    const issues = await this.validate(request);
    if (issues.length > 0) {
      return {
        kind: "not_submitted",
        errorCategory: "invalid_kra_sales_request",
        safeMessage: `The KRA sales request is invalid: ${issues.join("; ")}`,
      };
    }

    try {
      const outcome = await this.client.saveSales(request.payload, signal);
      if (outcome.kind === "rejected") {
        return {
          kind: "rejected",
          errorCategory: `kra_result_${outcome.resultCode}`,
          safeMessage: `KRA rejected the sales request with result code ${outcome.resultCode}.`,
          providerReference: null,
          safeMetadataJson: JSON.stringify({ resultCode: outcome.resultCode }),
        };
      }

      const data = outcome.response.data;
      if ("curRcptNo" in data) {
        return {
          kind: "accepted",
          providerReference: String(data.curRcptNo),
          safeMetadataJson: JSON.stringify({
            resultCode: outcome.response["resultCd"],
            resultDate: outcome.response["resultDt"] ?? null,
            receiptNumber: data.curRcptNo,
            totalReceiptNumber: data.totRcptNo,
          }),
        };
      }

      return {
        kind: "accepted",
        providerReference: String(data.rcptNo),
        safeMetadataJson: JSON.stringify({
          resultCode: outcome.response["resultCd"],
          resultDate: outcome.response["resultDt"] ?? null,
          receiptNumber: data.rcptNo,
          totalReceiptNumber: data.totRcptNo,
          sdcId: data.sdcId,
          mrcNo: data.mrcNo,
        }),
      };
    } catch (error: unknown) {
      if (error instanceof KraRequestError && error.category === "timeout") {
        safelyIncrementMetric(operationalMetrics, "adapter_timeouts", "timeout");
      }
      if (error instanceof KraRequestError && !error.outcomeMayBeUnknown) {
        return {
          kind: "not_submitted",
          errorCategory: error.category,
          safeMessage: error.message,
        };
      }
      return {
        kind: "outcome_unknown",
        errorCategory: error instanceof KraRequestError ? error.category : "adapter_exception",
        safeMessage:
          "The KRA sales result could not be confirmed; do not submit this invoice again.",
      };
    }
  }

  async reconcile(): Promise<EtimsAdapterReconciliationResult> {
    return {
      kind: "outcome_unknown",
      safeMessage: "KRA reconciliation lookup is not verified; manual review is required.",
    };
  }
}
