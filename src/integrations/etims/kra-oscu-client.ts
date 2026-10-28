import {
  KraJsonProtocolClient,
  kraOscuSalesRequestSchema,
  kraInitializationRequestSchema,
  validateKraAcceptedData,
  validateKraSalesRequest,
  isKraSalesRequestMapped,
  type KraCallOutcome,
  type KraInitializationRequest,
  type KraProtocolReadiness,
  type KraTypedCallOutcome,
  type KraOscuSalesResponseData,
  kraOscuSalesResponseDataSchema,
  KraRequestError,
} from "./kra-protocol-client.js";
import {
  kraBranchListDataSchema,
  kraCodeListDataSchema,
  kraItemClassListDataSchema,
  kraItemListDataSchema,
  kraOscuReferenceRequestSchema,
  type KraOscuReferenceRequest,
  type KraBranchListData,
  type KraCodeListData,
  type KraItemClassListData,
  type KraItemListData,
} from "./kra-reference-schemas.js";

export type KraOscuEnvironment = "sandbox" | "production";
export const KRA_OSCU_BASE_URLS: Readonly<Record<KraOscuEnvironment, string>> = {
  sandbox: "https://etims-api-sbx.kra.go.ke/etims-api/",
  production: "https://etims-api.kra.go.ke/etims-api/",
};

export interface KraOscuClientOptions {
  readonly environment: KraOscuEnvironment;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Direct JSON client for the OSCU v2.0 API. Calls are never retried. */
export class KraOscuClient {
  private readonly client: KraJsonProtocolClient;
  readonly environment: KraOscuEnvironment;

  constructor(options: KraOscuClientOptions) {
    this.environment = options.environment;
    const baseUrl = KRA_OSCU_BASE_URLS[options.environment];
    this.client = new KraJsonProtocolClient({
      baseUrl,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      allowedOrigin: (url) =>
        url.origin === new URL(baseUrl).origin && url.pathname === new URL(baseUrl).pathname,
    });
  }

  getReadiness(): KraProtocolReadiness {
    return {
      mode: "oscu",
      environment: this.environment,
      configured: true,
      configurationValid: true,
      transportReady: "not_checked",
      contractTests: "implemented_not_provider_verified",
      contractVerified: false,
      sandboxVerified: false,
      providerApproved: false,
      liveOperationPermitted: false,
      supportedOperations: [
        "initialize",
        "get_codes",
        "get_item_classifications",
        "get_branches",
        "get_items",
        "save_item",
        "save_sales",
      ],
      reconciliationVerified: false,
      blockers: [
        "kra_sandbox_acceptance_required",
        "taxpayer_enrollment_unverified",
        "invoice_mapping_unverified",
        "reconciliation_lookup_not_documented",
        "legal_sequence_unverified",
      ],
    };
  }

  initialize(request: KraInitializationRequest, signal?: AbortSignal): Promise<KraCallOutcome> {
    return this.client.post(
      "selectInitOsdcInfo",
      kraInitializationRequestSchema.parse(request),
      signal,
    );
  }

  async getCodes(
    request: KraOscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraCodeListData>> {
    const result = await this.client.post(
      "selectCodeList",
      kraOscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraCodeListDataSchema, "OSCU code-list");
  }

  async getItemClassifications(
    request: KraOscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraItemClassListData>> {
    const result = await this.client.post(
      "selectItemClsList",
      kraOscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraItemClassListDataSchema, "OSCU item-classification");
  }

  async getBranches(
    request: KraOscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraBranchListData>> {
    const result = await this.client.post(
      "selectBhfList",
      kraOscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraBranchListDataSchema, "OSCU branch-list");
  }

  async getItems(
    request: KraOscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraItemListData>> {
    const result = await this.client.post(
      "selectItemList",
      kraOscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraItemListDataSchema, "OSCU item-list");
  }

  saveItem(request: Record<string, unknown>, signal?: AbortSignal): Promise<KraCallOutcome> {
    return this.client.post("saveItem", request, signal);
  }

  async saveSales(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraOscuSalesResponseData>> {
    const issues = validateKraSalesRequest(request, "oscu");
    if (issues.length > 0)
      throw new KraRequestError(
        `Invalid OSCU sales request: ${issues.join("; ")}`,
        "configuration",
        false,
      );
    if (!isKraSalesRequestMapped(request, "oscu")) {
      throw new KraRequestError(
        "OSCU sales requests must be produced by the versioned fiscal mapping engine.",
        "configuration",
        false,
      );
    }
    const parsedRequest = kraOscuSalesRequestSchema.parse(request);
    const result = await this.client.post("saveTrnsSalesOsdc", parsedRequest, signal);
    return validateKraAcceptedData(
      result,
      kraOscuSalesResponseDataSchema,
      "OSCU sales response",
      true,
    );
  }
}
