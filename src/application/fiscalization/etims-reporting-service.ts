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
import type { EtimsSubmissionPayloadVault } from "./etims-submission-payload-vault.js";
import type { EtimsSubmissionPayloadRecord } from "./etims-submission-payload.js";
import { logger } from "../../observability/logger.js";

export interface EtimsReportingServiceOptions {
  readonly enabled: boolean;
  readonly selectedAdapterType?: "vscu" | "oscu";
  readonly verifiedReceiptLifecycle: boolean;
  readonly reconciliationTimeoutMs?: number;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export interface RegisterEtimsReportingOperationInput {
  readonly fiscalizationRequestId: string;
  readonly zohoInvoiceId: string;
  readonly payloadHash: string;
  readonly mappingConfigurationDigest?: string;
}

export interface EtimsReportingReadiness {
  readonly enabled: boolean;
  readonly selectedAdapterType: "vscu" | "oscu" | null;
  readonly status: "not_configured" | "blocked" | "ready";
  readonly simulated?: boolean;
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
    private readonly payloadVault?: EtimsSubmissionPayloadVault,
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
        simulated: false,
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
        simulated: false,
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
      simulated: adapter.status.simulated === true,
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

  async listReconciliationCandidates(
    limit: number,
  ): Promise<readonly EtimsReportingOperationDetails[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("eTIMS reconciliation batch size must be between 1 and 100.");
    }
    const readiness = this.getReadiness();
    if (readiness.status !== "ready" || !readiness.capabilities.supportsReconciliation) {
      return [];
    }
    return this.repository.findReconciliationCandidates(limit);
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
    if (
      input.mappingConfigurationDigest !== undefined &&
      !isSha256(input.mappingConfigurationDigest)
    ) {
      throw new Error("KRA mapping configuration digest must be a SHA-256 hexadecimal digest.");
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
    const adapterConfigurationId = adapter?.status.configurationId ?? null;
    const persistedConfigurationId = input.mappingConfigurationDigest
      ? `${adapterConfigurationId ?? "adapter-unselected"}|mapping-sha256:${input.mappingConfigurationDigest}`
      : adapterConfigurationId;
    if (persistedConfigurationId && persistedConfigurationId.length > 255) {
      throw new Error(
        "Combined provider and mapping configuration identity exceeds storage limits.",
      );
    }
    const operation: EtimsReportingOperation = {
      id: this.createId(),
      fiscalizationRequestId,
      zohoInvoiceId,
      adapterType,
      adapterConfigurationId: persistedConfigurationId,
      simulated: adapter ? adapter.status.simulated === true : null,
      correlationId: this.createId(),
      status,
      payloadHash: input.payloadHash.toLowerCase(),
      attemptNumber: 0,
      reconciliationAttemptNumber: 0,
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

  async submit(
    id: string,
    payload: unknown,
    signal?: AbortSignal,
    mappingConfiguration?: unknown,
  ): Promise<EtimsReportingOperationDetails> {
    const details = await this.requireOperation(id);
    const operation = details.operation;
    if (operation.status !== "pending" || operation.adapterType === null) {
      return details;
    }
    if (signal?.aborted) return details;
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

    if (!this.payloadVault) {
      return this.blockPending(operation, ["durable_submission_payload_storage_unavailable"]);
    }
    if (
      operation.adapterConfigurationId?.includes("|mapping-sha256:") &&
      mappingConfiguration === undefined
    ) {
      return this.blockPending(operation, ["historical_mapping_configuration_unavailable"]);
    }
    let payloadRecord: EtimsSubmissionPayloadRecord;
    try {
      payloadRecord = this.payloadVault.prepare(details, payload, this.now(), mappingConfiguration);
    } catch {
      return this.blockPending(operation, ["durable_submission_payload_invalid_or_unavailable"]);
    }
    const claimed = await this.repository.claimPending({
      operationId: id,
      now: this.now(),
      payload: payloadRecord,
    });
    if (!claimed) {
      return this.requireOperation(id);
    }

    let result: EtimsAdapterSubmissionResult;
    try {
      result = await adapter.submit(request, signal);
    } catch {
      result = {
        kind: "outcome_unknown",
        errorCategory: "adapter_exception",
        safeMessage: "The provider result could not be confirmed.",
      };
    }
    return this.persistResult(claimed, result);
  }

  /** Validates a mapped submission and encrypted archive before another stage runs. */
  async preflightSubmission(
    id: string,
    payload: unknown,
    mappingConfiguration: unknown,
  ): Promise<readonly string[]> {
    const details = await this.requireOperation(id);
    if (details.operation.status !== "pending") return [];
    const operation = details.operation;
    const adapter = operation.adapterType
      ? this.adapterByType.get(operation.adapterType)
      : undefined;
    if (
      !adapter ||
      !this.options.enabled ||
      !this.options.verifiedReceiptLifecycle ||
      !adapter.status.configured ||
      !adapter.status.contractVerified ||
      !adapter.status.operational
    ) {
      return adapter?.status.blockers.length
        ? adapter.status.blockers
        : ["selected_adapter_unavailable"];
    }
    if (!this.payloadVault) return ["durable_submission_payload_storage_unavailable"];
    let preparedRequest: PreparedEtimsReportingRequest;
    try {
      preparedRequest = this.toRequest(operation, payload);
    } catch {
      return ["prepared_payload_invalid"];
    }
    try {
      const blockers = await adapter.validate(preparedRequest);
      if (blockers.length > 0) return blockers;
    } catch {
      return ["adapter_validation_unavailable"];
    }
    try {
      this.payloadVault.prepare(details, payload, this.now(), mappingConfiguration);
    } catch {
      return ["durable_submission_payload_invalid_or_unavailable"];
    }
    return [];
  }

  async reconcile(
    id: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<EtimsReportingOperationDetails> {
    if (signal?.aborted) {
      return this.requireOperation(id);
    }
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
    const claimed = await this.repository.claimReconciliation(id, operation.status, this.now());
    if (!claimed) {
      return this.requireOperation(id);
    }

    let result: EtimsAdapterReconciliationResult;
    const timeoutMs = this.options.reconciliationTimeoutMs ?? 15_000;
    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutResult = new Promise<EtimsAdapterReconciliationResult>((resolve) => {
        timeout = setTimeout(() => {
          abortController.abort();
          resolve({ kind: "outcome_unknown", safeMessage: "Provider reconciliation timed out." });
        }, timeoutMs);
        timeout.unref();
      });
      const abortResult = new Promise<EtimsAdapterReconciliationResult>((resolve) => {
        if (signal?.aborted) {
          resolve({ kind: "outcome_unknown", safeMessage: "Reconciliation was cancelled." });
          return;
        }
        signal?.addEventListener(
          "abort",
          () => resolve({ kind: "outcome_unknown", safeMessage: "Reconciliation was cancelled." }),
          { once: true },
        );
      });
      const providerResult = Promise.resolve(adapter.reconcile(request, abortController.signal));
      const rawResult: unknown = await Promise.race([providerResult, timeoutResult, abortResult]);
      result = isReconciliationResult(rawResult)
        ? rawResult
        : {
            kind: "outcome_unknown",
            safeMessage: "The provider reconciliation response could not be validated.",
          };
    } catch {
      result = {
        kind: "outcome_unknown",
        safeMessage: "The provider reconciliation result could not be confirmed.",
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
    return this.persistReconciliationResult(claimed, result, adapter);
  }

  async recoverStaleInProgress(staleBefore: Date): Promise<number> {
    const now = this.now();
    const [submissions, reconciliations] = await Promise.all([
      this.repository.markStaleInProgressOutcomeUnknown(staleBefore, now),
      this.repository.markStaleReconciliationRequired(staleBefore, now),
    ]);
    return submissions + reconciliations;
  }

  async blockReconciliation(
    id: string,
    errorCategory: string,
    safeMessage: string,
  ): Promise<EtimsReportingOperationDetails> {
    const current = await this.requireOperation(id);
    if (
      current.operation.status !== "outcome_unknown" &&
      current.operation.status !== "reconciliation_required"
    ) {
      return current;
    }
    const blocked = await this.transition(current.operation, "blocked", {
      providerReference: current.operation.providerReference,
      providerMetadataJson: current.operation.providerMetadataJson,
      errorCategory: sanitizedText(errorCategory, 100),
      errorMessage: sanitizedText(safeMessage),
      reconciliationRequired: false,
    });
    return blocked ?? this.requireOperation(id);
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
      result.kind === "not_submitted"
        ? "blocked"
        : result.kind === "accepted"
          ? "accepted"
          : result.kind === "rejected"
            ? "rejected"
            : "outcome_unknown";
    const now = this.now();
    const operation: EtimsReportingOperation = {
      ...claimed,
      status: next,
      providerReference:
        result.kind === "accepted" || result.kind === "rejected"
          ? safeProviderReference(result.providerReference)
          : null,
      providerMetadataJson:
        result.kind === "accepted" || result.kind === "rejected"
          ? safeJson(result.safeMetadataJson)
          : null,
      errorCategory: result.kind === "accepted" ? null : sanitizedText(result.errorCategory, 100),
      errorMessage: result.kind === "accepted" ? null : sanitizedText(result.safeMessage),
      reconciliationRequired: result.kind === "outcome_unknown",
      updatedAt: now,
    };
    assertEtimsReportingTransition(claimed.status, next);
    const attempt: EtimsReportingAttempt = {
      id: this.createId(),
      operationId: claimed.id,
      attemptType: "submission",
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
    if (next !== "accepted") {
      logger.warn(
        {
          requestId: claimed.fiscalizationRequestId,
          operationId: claimed.id,
          adapterType: claimed.adapterType,
          outcome: next,
          category:
            next === "rejected"
              ? "provider_rejected"
              : result.kind === "outcome_unknown" && result.errorCategory === "timeout"
                ? "timeout"
                : next === "blocked"
                  ? "not_submitted"
                  : "uncertain_outcome",
        },
        "eTIMS adapter returned a non-success outcome",
      );
    }
    return this.requireOperation(claimed.id);
  }

  private async persistReconciliationResult(
    operation: EtimsReportingOperation,
    result: EtimsAdapterReconciliationResult,
    adapter: EtimsReportingAdapter,
  ): Promise<EtimsReportingOperationDetails> {
    let status: EtimsReportingState;
    let providerReference = operation.providerReference;
    let providerMetadataJson = operation.providerMetadataJson;
    let errorCategory: string | null;
    let errorMessage: string | null;
    let reconciliationRequired = false;

    if (result.kind === "outcome_unknown" || result.kind === "pending") {
      status = "reconciliation_required";
      errorCategory = result.kind === "pending" ? "provider_pending" : "reconciliation_unknown";
      errorMessage = sanitizedText(result.safeMessage);
      reconciliationRequired = true;
    } else if (result.kind === "confirmed_not_found") {
      const maySafelyRetry =
        adapter.status.capabilities.safeResubmissionAfterConfirmedNotFound === true;
      status = maySafelyRetry ? "pending" : "reconciliation_required";
      errorCategory = maySafelyRetry ? "confirmed_not_found" : "resubmission_not_verified";
      errorMessage = maySafelyRetry
        ? "Provider confirmed no transaction; an explicit submit call is required."
        : "The provider confirmed no transaction; safe resubmission is not verified.";
      reconciliationRequired = !maySafelyRetry;
    } else {
      status = result.kind;
      providerReference = safeProviderReference(result.providerReference);
      providerMetadataJson = safeJson(result.safeMetadataJson);
      errorCategory = result.kind === "rejected" ? sanitizedText(result.errorCategory, 100) : null;
      errorMessage = result.kind === "rejected" ? sanitizedText(result.safeMessage) : null;
    }

    const now = this.now();
    const updated: EtimsReportingOperation = {
      ...operation,
      status,
      providerReference,
      providerMetadataJson,
      errorCategory,
      errorMessage,
      reconciliationRequired,
      updatedAt: now,
    };
    assertEtimsReportingTransition("reconciling", status);
    const attempt: EtimsReportingAttempt = {
      id: this.createId(),
      operationId: operation.id,
      attemptType: "reconciliation",
      attemptNumber: operation.reconciliationAttemptNumber,
      startedAt: operation.updatedAt,
      completedAt: now,
      outcome:
        result.kind === "accepted" || result.kind === "rejected"
          ? result.kind
          : result.kind === "confirmed_not_found"
            ? "confirmed_not_found"
            : result.kind === "pending"
              ? "pending"
              : "outcome_unknown",
      providerReference,
      errorCategory,
      errorMessage,
    };
    const saved = await this.repository.completeAttempt(updated, attempt);
    if (!saved) {
      throw new Error("The eTIMS reconciliation outcome could not be persisted.");
    }
    return this.requireOperation(operation.id);
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
    kind === "not_submitted" &&
    typeof result["errorCategory"] === "string" &&
    typeof result["safeMessage"] === "string"
  ) {
    return true;
  }
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

function isReconciliationResult(value: unknown): value is EtimsAdapterReconciliationResult {
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
  if (kind === "rejected") {
    return (
      typeof result["errorCategory"] === "string" &&
      typeof result["safeMessage"] === "string" &&
      (providerReference === null || typeof providerReference === "string") &&
      (safeMetadataJson === null || typeof safeMetadataJson === "string")
    );
  }
  if (kind === "confirmed_not_found") {
    return true;
  }
  return (
    (kind === "outcome_unknown" || kind === "pending") && typeof result["safeMessage"] === "string"
  );
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
