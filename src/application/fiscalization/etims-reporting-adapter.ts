import type { EtimsAdapterType } from "../../domain/fiscalization/etims-reporting.js";

export interface PreparedEtimsReportingRequest {
  readonly operationId: string;
  readonly fiscalizationRequestId: string;
  readonly zohoInvoiceId: string;
  readonly correlationId: string;
  readonly payloadHash: string;
  readonly payload: unknown;
}

export interface EtimsAdapterCapabilities {
  readonly supportsReconciliation: boolean;
  readonly safeResubmissionAfterConfirmedNotFound: boolean;
}

export interface EtimsAdapterStatus {
  readonly adapterType: EtimsAdapterType;
  readonly configured: boolean;
  readonly contractVerified: boolean;
  readonly operational: boolean;
  readonly configurationId: string | null;
  readonly blockers: readonly string[];
  readonly capabilities: EtimsAdapterCapabilities;
}

export type EtimsAdapterSubmissionResult =
  | {
      readonly kind: "accepted";
      readonly providerReference: string | null;
      readonly safeMetadataJson: string | null;
    }
  | {
      readonly kind: "rejected";
      readonly errorCategory: string;
      readonly safeMessage: string;
      readonly providerReference: string | null;
      readonly safeMetadataJson: string | null;
    }
  | {
      readonly kind: "outcome_unknown";
      readonly errorCategory: string;
      readonly safeMessage: string;
    };

export type EtimsAdapterReconciliationResult =
  | {
      readonly kind: "accepted";
      readonly providerReference: string | null;
      readonly safeMetadataJson: string | null;
    }
  | {
      readonly kind: "rejected";
      readonly errorCategory: string;
      readonly safeMessage: string;
      readonly providerReference: string | null;
      readonly safeMetadataJson: string | null;
    }
  | { readonly kind: "confirmed_not_found" }
  | { readonly kind: "outcome_unknown"; readonly safeMessage: string };

export interface EtimsReportingAdapter {
  readonly status: EtimsAdapterStatus;
  validate(request: PreparedEtimsReportingRequest): Promise<readonly string[]>;
  submit(request: PreparedEtimsReportingRequest): Promise<EtimsAdapterSubmissionResult>;
  reconcile(request: PreparedEtimsReportingRequest): Promise<EtimsAdapterReconciliationResult>;
}

export class UnverifiedEtimsAdapter implements EtimsReportingAdapter {
  readonly status: EtimsAdapterStatus;

  constructor(adapterType: EtimsAdapterType, selected: boolean, enabled: boolean) {
    this.status = {
      adapterType,
      configured: false,
      contractVerified: false,
      operational: false,
      configurationId: null,
      blockers: [
        ...(!enabled ? ["reporting_disabled"] : []),
        ...(!selected ? ["adapter_not_selected"] : []),
        "provider_contract_unverified",
        "customer_enrollment_unverified",
      ],
      capabilities: {
        supportsReconciliation: false,
        safeResubmissionAfterConfirmedNotFound: false,
      },
    };
  }

  async validate(): Promise<readonly string[]> {
    return this.status.blockers;
  }

  async submit(): Promise<EtimsAdapterSubmissionResult> {
    throw new Error("The eTIMS provider contract is not verified; submission is disabled.");
  }

  async reconcile(): Promise<EtimsAdapterReconciliationResult> {
    throw new Error("The eTIMS provider contract does not support verified reconciliation.");
  }
}
