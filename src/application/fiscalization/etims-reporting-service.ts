import { createHash, randomUUID } from "node:crypto";
import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingOperationDetails,
  EtimsReportingState,
} from "../../domain/fiscalization/etims-reporting.js";
import {
  assertEtimsReportingTransition,
  isEtimsAdapterType,
} from "../../domain/fiscalization/etims-reporting.js";
import type {
  EtimsAdapterReconciliationResult,
  EtimsAdapterSubmissionResult,
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "./etims-reporting-adapter.js";
import type { EtimsReportingRepository } from "./etims-reporting-repository.js";

export interface EtimsReportingServiceOptions {
  readonly enabled: boolean;
  readonly selectedAdapterType?: "vscu" | "oscu";
  readonly verifiedReceiptLifecycle: boolean;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface RegisterEtimsReportingOperationInput {
  readonly fiscalizationRequestId: string;
  readonly zohoInvoiceId: string;
  readonly payloadHash: string;
}

export interface EtimsReportingReadiness {
  readonly enabled: boolean;
  readonly selectedAdapterType: "vscu" | "oscu" | null;
  readonly status: "not_configured" | "blocked" | "ready";
  readonly blockers: readonly string[];
  readonly capabilities: {
    readonly supportsReconciliation: boolean;
    readonly safeResubmissionAfterConfirmedNotFound: boolean;
  };
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export function hashEtimsPayload(payload: unknown): string {
  const serialized = JSON.stringify(canonicalizePayload(payload));
  return createHash("sha256").update(serialized).digest("hex");
}

function canonicalizePayload(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizePayload);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Prepared eTIMS payload must contain only JSON-compatible values.");
    }
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizePayload(item)]),
    );
  }
  throw new Error("Prepared eTIMS payload must contain only JSON-compatible values.");
}

function sanitizedText(value: string, maximumLength = 500): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(
      /\bauthorization\b\s*[:=]\s*(?:bearer\s+)?\S+|\bbearer\s+\S+|\b(token|password|secret|api[_ -]?key|pin)\b\s*[:=]\s*\S+/gi,
      "[redacted]",
    )
    .trim()
    .slice(0, maximumLength);
}

export class EtimsReportingService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly adapterByType: ReadonlyMap<"vscu" | "oscu", EtimsReportingAdapter>;

  constructor(
    private readonly repository: EtimsReportingRepository,
    adapters: readonly EtimsReportingAdapter[],
    private readonly options: EtimsReportingServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.adapterByType = new Map(adapters.map((adapter) => [adapter.status.adapterType, adapter]));
    if (this.adapterByType.size !== adapters.length) {
      throw new Error("Only one eTIMS adapter may be registered for each adapter type.");
    }
  }

  getReadiness(): EtimsReportingReadiness {
    const adapterType = this.options.selectedAdapterType ?? null;
    if (!this.options.enabled || adapterType === null) {
      return {
        enabled: this.options.enabled,
        selectedAdapterType: adapterType,
        status: "not_configured",
        blockers: [
          ...(!this.options.enabled ? ["reporting_disabled"] : []),
          ...(adapterType === null
            ? [
                "adapter_not_selected",
                "provider_contract_unverified",
                "customer_enrollment_unverified",
                "invoice_and_tax_mapping_incomplete",
                "duplicate_reconciliation_unverified",
              ]
            : []),
        ],
        capabilities: {
          supportsReconciliation: false,
          safeResubmissionAfterConfirmedNotFound: false,
        },
      };
    }

    const adapter = this.adapterByType.get(adapterType);
    if (!adapter) {
      return {
        enabled: true,
        selectedAdapterType: adapterType,
        status: "blocked",
        blockers: ["selected_adapter_unavailable"],
        capabilities: {
          supportsReconciliation: false,
          safeResubmissionAfterConfirmedNotFound: false,
        },
      };
    }

    const operational =
      this.options.enabled &&
      this.options.verifiedReceiptLifecycle &&
      adapter.status.configured &&
      adapter.status.contractVerified &&
      adapter.status.operational;
    return {
      enabled: this.options.enabled,
      selectedAdapterType: adapterType,
      status: operational ? "ready" : "blocked",
      blockers: operational
        ? []
        : [
            ...adapter.status.blockers,
            ...(!this.options.verifiedReceiptLifecycle
              ? ["verified_receipt_lifecycle_unavailable"]
              : []),
            ...(!adapter.status.operational ? ["adapter_not_operational"] : []),
          ],
      capabilities: adapter.status.capabilities,
    };
  }

  async getByFiscalizationRequestId(
    fiscalizationRequestId: string,
  ): Promise<EtimsReportingOperationDetails | null> {
    return this.repository.findByFiscalizationRequestId(fiscalizationRequestId);
  }

  async register(input: RegisterEtimsReportingOperationInput): Promise<EtimsReportingOperation> {
    const fiscalizationRequestId = input.fiscalizationRequestId.trim();
    const zohoInvoiceId = input.zohoInvoiceId.trim();
    if (!fiscalizationRequestId || !zohoInvoiceId) {
      throw new Error("Fiscalization request and Zoho invoice identifiers are required.");
    }
    if (!isSha256(input.payloadHash)) {
      throw new Error("eTIMS payload hash must be a SHA-256 hexadecimal digest.");
    }

    const readiness = this.getReadiness();
    const status: EtimsReportingState =
      readiness.status === "ready"
        ? "pending"
        : readiness.status === "not_configured"
          ? "not_configured"
          : "blocked";
    const now = this.now();
    const adapterType =
      readiness.selectedAdapterType && isEtimsAdapterType(readiness.selectedAdapterType)
        ? readiness.selectedAdapterType
        : null;
    const adapter = adapterType ? this.adapterByType.get(adapterType) : undefined;
    const operation: EtimsReportingOperation = {
      id: this.createId(),
      fiscalizationRequestId,
      zohoInvoiceId,
      adapterType,
      adapterConfigurationId: adapter?.status.configurationId ?? null,
      correlationId: this.createId(),
      status,
      payloadHash: input.payloadHash.toLowerCase(),
      attemptNumber: 0,
      providerReference: null,
      providerMetadataJson: null,
      errorCategory: readiness.blockers[0] ?? null,
      errorMessage: readiness.blockers.length > 0 ? readiness.blockers.join(", ") : null,
      reconciliationRequired: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.create(operation);
    return operation;
  }

  async submit(id: string, payload: unknown): Promise<EtimsReportingOperationDetails> {
    const details = await this.requireOperation(id);
    const operation = details.operation;
    if (operation.status !== "pending" || operation.adapterType === null) {
      return details;
    }
    const adapter = this.adapterByType.get(operation.adapterType);
    if (
      !adapter ||
      !this.options.enabled ||
      !this.options.verifiedReceiptLifecycle ||
      !adapter.status.configured ||
      !adapter.status.contractVerified ||
      !adapter.status.operational
    ) {
      const readiness = adapter?.status.blockers ?? ["selected_adapter_unavailable"];
      return this.blockPending(operation, readiness);
    }

    const request = this.toRequest(operation, payload);
    const blockers = await adapter.validate(request);
    if (blockers.length > 0) {
      return this.blockPending(operation, blockers);
    }

    const claimed = await this.repository.claimPending(id, this.now());
    if (!claimed) {
      return this.requireOperation(id);
    }

    let result: EtimsAdapterSubmissionResult;
    try {
      result = await adapter.submit(request);
    } catch {
      result = {
        kind: "outcome_unknown",
        errorCategory: "adapter_exception",
        safeMessage: "The provider result could not be confirmed.",
      };
    }
    return this.persistResult(claimed, result);
  }

  async reconcile(id: string, payload: unknown): Promise<EtimsReportingOperationDetails> {
    const details = await this.requireOperation(id);
    const operation = details.operation;
    if (operation.status !== "outcome_unknown" && operation.status !== "reconciliation_required") {
      return details;
    }
    if (!operation.adapterType) {
      return details;
    }
    const adapter = this.adapterByType.get(operation.adapterType);
    if (
      !adapter ||
      !this.options.enabled ||
      !this.options.verifiedReceiptLifecycle ||
      !adapter.status.operational ||
      !adapter.status.contractVerified ||
      !adapter.status.capabilities.supportsReconciliation
    ) {
      return this.transitionToReconciliationRequired(operation);
    }

    const request = this.toRequest(operation, payload);
    const reconciling =
      operation.status === "outcome_unknown"
        ? await this.transition(operation, "reconciliation_required", {
            reconciliationRequired: true,
            errorCategory: "reconciliation_started",
            errorMessage: "Provider reconciliation is required; no resubmission was performed.",
          })
        : { operation, attempts: details.attempts };
    if (!reconciling) {
      return this.requireOperation(id);
    }

    let result: EtimsAdapterReconciliationResult;
    try {
      result = await adapter.reconcile(request);
    } catch {
      result = {
        kind: "outcome_unknown",
        safeMessage: "The provider reconciliation result could not be confirmed.",
      };
    }
    return this.persistReconciliationResult(reconciling.operation, result, adapter);
  }

  async recoverStaleInProgress(staleBefore: Date): Promise<number> {
    return this.repository.markStaleInProgressOutcomeUnknown(staleBefore, this.now());
  }

  private async requireOperation(id: string): Promise<EtimsReportingOperationDetails> {
    const operation = await this.repository.findById(id);
    if (!operation) {
      throw new Error("eTIMS reporting operation was not found.");
    }
    return operation;
  }

  private toRequest(
    operation: EtimsReportingOperation,
    payload: unknown,
  ): PreparedEtimsReportingRequest {
    const payloadHash = hashEtimsPayload(payload);
    if (payloadHash !== operation.payloadHash) {
      throw new Error("Prepared eTIMS payload does not match the immutable payload hash.");
    }
    return {
      operationId: operation.id,
      fiscalizationRequestId: operation.fiscalizationRequestId,
      zohoInvoiceId: operation.zohoInvoiceId,
      correlationId: operation.correlationId,
      payloadHash: operation.payloadHash,
      payload,
    };
  }

  private async blockPending(
    operation: EtimsReportingOperation,
    blockers: readonly string[],
  ): Promise<EtimsReportingOperationDetails> {
    const updated = await this.transition(operation, "blocked", {
      errorCategory: sanitizedText(blockers[0] ?? "validation_failed", 100),
      errorMessage: sanitizedText(blockers.join("; ")),
      reconciliationRequired: false,
    });
    return updated ?? this.requireOperation(operation.id);
  }

  private async transition(
    operation: EtimsReportingOperation,
    next: EtimsReportingState,
    updates: Partial<
      Pick<
        EtimsReportingOperation,
        | "providerReference"
        | "providerMetadataJson"
        | "errorCategory"
        | "errorMessage"
        | "reconciliationRequired"
      >
    >,
  ): Promise<EtimsReportingOperationDetails | null> {
    assertEtimsReportingTransition(operation.status, next);
    const changed = await this.repository.transition(operation.id, operation.status, {
      ...operation,
      ...updates,
      status: next,
      updatedAt: this.now(),
    });
    return changed ? this.requireOperation(operation.id) : null;
  }

  private async transitionToReconciliationRequired(
    operation: EtimsReportingOperation,
  ): Promise<EtimsReportingOperationDetails> {
    if (operation.status === "outcome_unknown") {
      const result = await this.transition(operation, "reconciliation_required", {
        providerReference: operation.providerReference,
        providerMetadataJson: operation.providerMetadataJson,
        errorCategory: "reconciliation_unsupported",
        errorMessage: "The selected provider does not support verified reconciliation.",
        reconciliationRequired: true,
      });
      return result ?? this.requireOperation(operation.id);
    }
    return this.requireOperation(operation.id);
  }

  private async persistResult(
    claimed: EtimsReportingOperation,
    rawResult: EtimsAdapterSubmissionResult,
  ): Promise<EtimsReportingOperationDetails> {
    const result = isSubmissionResult(rawResult)
      ? rawResult
      : {
          kind: "outcome_unknown" as const,
          errorCategory: "malformed_adapter_response",
          safeMessage: "The provider result could not be confirmed.",
        };
    const next: EtimsReportingState =
      result.kind === "accepted"
        ? "accepted"
        : result.kind === "rejected"
          ? "rejected"
          : "outcome_unknown";
    const now = this.now();
    const operation: EtimsReportingOperation = {
      ...claimed,
      status: next,
      providerReference:
        result.kind === "outcome_unknown" ? null : safeProviderReference(result.providerReference),
      providerMetadataJson:
        result.kind === "outcome_unknown" ? null : safeJson(result.safeMetadataJson),
      errorCategory: result.kind === "accepted" ? null : result.errorCategory,
      errorMessage: result.kind === "accepted" ? null : sanitizedText(result.safeMessage),
      reconciliationRequired: result.kind === "outcome_unknown",
      updatedAt: now,
    };
    assertEtimsReportingTransition(claimed.status, next);
    const attempt: EtimsReportingAttempt = {
      id: this.createId(),
      operationId: claimed.id,
      attemptNumber: claimed.attemptNumber,
      startedAt: claimed.updatedAt,
      completedAt: now,
      outcome:
        next === "accepted" || next === "rejected" || next === "outcome_unknown" ? next : null,
      providerReference: operation.providerReference,
      errorCategory: operation.errorCategory,
      errorMessage: operation.errorMessage,
    };
    const saved = await this.repository.completeAttempt(operation, attempt);
    if (!saved) {
      throw new Error("The eTIMS submission outcome could not be persisted.");
    }
    return this.requireOperation(claimed.id);
  }

  private async persistReconciliationResult(
    operation: EtimsReportingOperation,
    result: EtimsAdapterReconciliationResult,
    adapter: EtimsReportingAdapter,
  ): Promise<EtimsReportingOperationDetails> {
    if (result.kind === "outcome_unknown") {
      const updated = await this.repository.transition(operation.id, "reconciliation_required", {
        ...operation,
        errorCategory: "reconciliation_unknown",
        errorMessage: sanitizedText(result.safeMessage),
        updatedAt: this.now(),
      });
      return updated ? this.requireOperation(operation.id) : this.requireOperation(operation.id);
    }
    if (result.kind === "confirmed_not_found") {
      const maySafelyRetry =
        adapter.status.capabilities.safeResubmissionAfterConfirmedNotFound === true;
      if (!maySafelyRetry) {
        return this.requireOperation(operation.id);
      }
      const transitioned = await this.transition(operation, "pending", {
        providerReference: operation.providerReference,
        providerMetadataJson: operation.providerMetadataJson,
        errorCategory: "confirmed_not_found",
        errorMessage:
          "Provider confirmed no transaction; explicit operator resubmission is required.",
        reconciliationRequired: false,
      });
      return transitioned ?? this.requireOperation(operation.id);
    }

    const next = result.kind;
    const updated: EtimsReportingOperation = {
      ...operation,
      status: next,
      providerReference: safeProviderReference(result.providerReference),
      providerMetadataJson: safeJson(result.safeMetadataJson),
      errorCategory: result.kind === "rejected" ? result.errorCategory : null,
      errorMessage: result.kind === "rejected" ? sanitizedText(result.safeMessage) : null,
      reconciliationRequired: false,
      updatedAt: this.now(),
    };
    assertEtimsReportingTransition(operation.status, next);
    const saved = await this.repository.transition(operation.id, operation.status, updated);
    return saved ? this.requireOperation(operation.id) : this.requireOperation(operation.id);
  }
}

function safeJson(value: string | null): string | null {
  if (value === null || value.length > 4000) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    const sanitized = redactMetadata(parsed);
    const serialized = JSON.stringify(sanitized);
    return serialized.length <= 4000 ? serialized : null;
  } catch {
    return null;
  }
}

function isSubmissionResult(value: unknown): value is EtimsAdapterSubmissionResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const result = value as Record<string, unknown>;
  const kind = result["kind"];
  const providerReference = result["providerReference"];
  const safeMetadataJson = result["safeMetadataJson"];
  if (
    kind === "accepted" &&
    (providerReference === null || typeof providerReference === "string") &&
    (safeMetadataJson === null || typeof safeMetadataJson === "string")
  ) {
    return true;
  }
  if (kind === "rejected" || kind === "outcome_unknown") {
    return (
      typeof result["errorCategory"] === "string" &&
      typeof result["safeMessage"] === "string" &&
      (kind === "outcome_unknown" ||
        providerReference === null ||
        typeof providerReference === "string") &&
      (kind === "outcome_unknown" ||
        safeMetadataJson === null ||
        typeof safeMetadataJson === "string")
    );
  }
  return false;
}

function safeProviderReference(reference: string | null): string | null {
  if (
    reference === null ||
    reference.length > 255 ||
    /\b(token|secret|password|authorization|bearer|api[_ -]?key|pin)\b/i.test(reference)
  ) {
    return null;
  }
  return reference.replace(/[\r\n\t]/g, "").trim() || null;
}

function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactMetadata);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(token|secret|password|authorization|payload|invoice|customer|taxpayer|pin|key)/i.test(
              key,
            ),
        )
        .map(([key, item]) => [key, redactMetadata(item)]),
    );
  }
  if (typeof value === "string") {
    return sanitizedText(value, 500);
  }
  return value;
}
