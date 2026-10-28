import {
  KraJsonProtocolClient,
  kraVscuSalesRequestSchema,
  kraInitializationRequestSchema,
  validateKraAcceptedData,
  validateKraSalesRequest,
  isKraSalesRequestMapped,
  type KraCallOutcome,
  type KraInitializationRequest,
  type KraProtocolReadiness,
  type KraTypedCallOutcome,
  type KraVscuSalesResponseData,
  kraVscuSalesResponseDataSchema,
  KraRequestError,
} from "./kra-protocol-client.js";
import {
  kraBranchListDataSchema,
  kraCodeListDataSchema,
  kraItemClassListDataSchema,
  kraItemListDataSchema,
  kraVscuReferenceRequestSchema,
  type KraVscuReferenceRequest,
  type KraBranchListData,
  type KraCodeListData,
  type KraItemClassListData,
  type KraItemListData,
} from "./kra-reference-schemas.js";

export interface KraVscuClientOptions {
  /** Origin of the taxpayer-installed official VSCU JAR service. */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Local VSCU REST service client. Its route table is independent of OSCU. */
export class KraVscuClient {
  private readonly client: KraJsonProtocolClient;
  readonly baseUrl: string;

  constructor(options: KraVscuClientOptions) {
    this.baseUrl = options.baseUrl;
    this.client = new KraJsonProtocolClient({
      baseUrl: options.baseUrl,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      allowedOrigin: (url) => url.protocol === "http:" || url.protocol === "https:",
    });
  }

  getReadiness(): KraProtocolReadiness {
    return {
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
        "official_vscu_package_installation_unverified",
        "taxpayer_enrollment_unverified",
        "invoice_mapping_unverified",
        "reconciliation_lookup_not_documented",
        "legal_sequence_unverified",
      ],
    };
  }

  initialize(request: KraInitializationRequest, signal?: AbortSignal): Promise<KraCallOutcome> {
    return this.client.post(
      "initializer/selectInitInfo",
      kraInitializationRequestSchema.parse(request),
      signal,
    );
  }

  async getCodes(
    request: KraVscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraCodeListData>> {
    const result = await this.client.post(
      "code/selectCodes",
      kraVscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraCodeListDataSchema, "VSCU code-list");
  }

  async getItemClassifications(
    request: KraVscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraItemClassListData>> {
    const result = await this.client.post(
      "itemClass/selectItemsClass",
      kraVscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraItemClassListDataSchema, "VSCU item-classification");
  }

  async getBranches(
    request: KraVscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraBranchListData>> {
    const result = await this.client.post(
      "branches/selectBranches",
      kraVscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraBranchListDataSchema, "VSCU branch-list");
  }

  async getItems(
    request: KraVscuReferenceRequest,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraItemListData>> {
    const result = await this.client.post(
      "items/selectItems",
      kraVscuReferenceRequestSchema.parse(request),
      signal,
      false,
    );
    return validateKraAcceptedData(result, kraItemListDataSchema, "VSCU item-list");
  }

  saveItem(request: Record<string, unknown>, signal?: AbortSignal): Promise<KraCallOutcome> {
    return this.client.post("items/saveItems", request, signal);
  }

  async saveSales(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<KraTypedCallOutcome<KraVscuSalesResponseData>> {
    const issues = validateKraSalesRequest(request, "vscu");
    if (issues.length > 0)
      throw new KraRequestError(
        `Invalid VSCU sales request: ${issues.join("; ")}`,
        "configuration",
        false,
      );
    if (!isKraSalesRequestMapped(request, "vscu")) {
      throw new KraRequestError(
        "VSCU sales requests must be produced by the versioned fiscal mapping engine.",
        "configuration",
        false,
      );
    }
    const parsedRequest = kraVscuSalesRequestSchema.parse(request);
    const result = await this.client.post("trnsSales/saveSales", parsedRequest, signal);
    return validateKraAcceptedData(
      result,
      kraVscuSalesResponseDataSchema,
      "VSCU sales response",
      true,
    );
  }
}
