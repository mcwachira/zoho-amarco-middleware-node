import type { EtimsReportingOperationDetails } from "../../domain/fiscalization/etims-reporting.js";
import type {
  FiscalizationAttempt,
  FiscalizationRecord,
} from "../../domain/fiscalization/fiscalization-record.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";
import type { EtimsReportingService } from "./etims-reporting-service.js";
import { hashEtimsPayload } from "./etims-reporting-service.js";
import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalizationService } from "./fiscalization-service.js";
import type { PrepareFiscalizationRequestService } from "./prepare-fiscalization-request.js";
import { parseFiscalizationSnapshot } from "./fiscalization-snapshot.js";
import {
  mapFiscalizationSnapshotToKraSalesRequest,
  kraSalesMappingConfigurationSchema,
  type KraSalesMappingResult,
} from "../etims/kra-sales-mapping.js";

export type FiscalizationWorkflowStage = "device" | "etims";

export interface VerifiedFiscalizationWorkflowPolicy {
  /** The sequence has been confirmed by the relevant legal and provider contracts. */
  readonly verificationReference: string;
  readonly orderedStages: readonly [FiscalizationWorkflowStage, FiscalizationWorkflowStage];
  /** The verified rule for whether the next stage may run after this result. */
  readonly mayContinue: (
    completedStage: FiscalizationWorkflowStage,
    result: FiscalizationRecord | EtimsReportingOperationDetails,
  ) => boolean;
}

/** Explicit local-only sequence policy. Its results remain simulation evidence. */
export interface SimulatedFiscalizationWorkflowPolicy {
  readonly simulated: true;
  readonly scenarioId: string;
  readonly orderedStages: readonly [FiscalizationWorkflowStage, FiscalizationWorkflowStage];
  readonly mayContinue: VerifiedFiscalizationWorkflowPolicy["mayContinue"];
}

export type FiscalizationWorkflowPolicy =
  VerifiedFiscalizationWorkflowPolicy | SimulatedFiscalizationWorkflowPolicy;

export interface FiscalizationWorkflowStatus {
  readonly fiscalization: FiscalizationRecord;
  readonly deviceAttempts: readonly FiscalizationAttempt[];
  readonly etims: EtimsReportingOperationDetails | null;
}

export class FiscalizationWorkflowRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Fiscalization request "${id}" was not found.`);
    this.name = "FiscalizationWorkflowRequestNotFoundError";
  }
}

export class FiscalizationWorkflowSequenceUnverifiedError extends Error {
  constructor() {
    super(
      "The combined device and eTIMS workflow is blocked until its legal sequence is verified.",
    );
    this.name = "FiscalizationWorkflowSequenceUnverifiedError";
  }
}

export class FiscalizationMappingConfigurationConflictError extends Error {
  constructor() {
    super("The existing eTIMS operation is bound to a different mapping configuration.");
    this.name = "FiscalizationMappingConfigurationConflictError";
  }
}

/**
 * Coordinates existing stage services without merging their state machines.
 * Individual stages remain independently callable; the combined workflow
 * refuses to run until a contract-backed sequence policy is supplied.
 */
export class FiscalizationOrchestrationService {
  constructor(
    private readonly repository: FiscalizationRepository,
    private readonly preparation:
      Pick<PrepareFiscalizationRequestService, "prepare" | "synchronize"> | undefined,
    private readonly fiscalization: Pick<FiscalizationService, "fiscalize">,
    private readonly etims: Pick<
      EtimsReportingService,
      | "getByFiscalizationRequestId"
      | "getReadiness"
      | "register"
      | "submit"
      | "preflightSubmission"
      | "reconcile"
    >,
    private readonly workflowPolicy?: FiscalizationWorkflowPolicy,
  ) {}

  async prepareInvoice(invoiceId: string) {
    if (!this.preparation) {
      throw new Error("Fiscalization request preparation is not configured.");
    }
    return this.preparation.prepare(invoiceId);
  }

  async synchronizeInvoice(invoiceId: string) {
    if (!this.preparation) {
      throw new Error("Fiscalization request preparation is not configured.");
    }
    return this.preparation.synchronize(invoiceId);
  }

  processDeviceStage(requestId: string): Promise<FiscalizationRecord> {
    return this.fiscalization.fiscalize({ id: requestId });
  }

  async submitEtimsStage(
    requestId: string,
    payload: unknown,
    signal?: AbortSignal,
    mappingConfigurationDigest?: string,
    mappingConfiguration?: unknown,
  ): Promise<EtimsReportingOperationDetails> {
    const details = await this.getOrRegisterEtimsOperation(
      requestId,
      payload,
      mappingConfigurationDigest,
    );

    // The eTIMS state machine itself refuses resubmission from in-progress,
    // accepted, rejected, or uncertain states. We do not retry those here.
    return this.etims.submit(details.operation.id, payload, signal, mappingConfiguration);
  }

  private async getOrRegisterEtimsOperation(
    requestId: string,
    payload: unknown,
    mappingConfigurationDigest?: string,
  ): Promise<EtimsReportingOperationDetails> {
    const record = await this.repository.findById(requestId);
    if (!record) throw new FiscalizationWorkflowRequestNotFoundError(requestId);
    let details = await this.etims.getByFiscalizationRequestId(requestId);
    if (!details) {
      const operation = await this.etims
        .register({
          fiscalizationRequestId: record.id,
          zohoInvoiceId: record.zohoInvoiceId,
          payloadHash: hashEtimsPayload(payload),
          ...(mappingConfigurationDigest ? { mappingConfigurationDigest } : {}),
        })
        .catch(async (error: unknown) => {
          const winner = await this.etims.getByFiscalizationRequestId(requestId);
          if (winner) return winner.operation;
          throw error;
        });
      details = await this.etims.getByFiscalizationRequestId(requestId);
      if (!details) {
        throw new Error(`eTIMS operation "${operation.id}" could not be read after registration.`);
      }
    }
    if (
      mappingConfigurationDigest &&
      !details.operation.adapterConfigurationId?.endsWith(
        `|mapping-sha256:${mappingConfigurationDigest}`,
      )
    ) {
      throw new FiscalizationMappingConfigurationConflictError();
    }
    return details;
  }

  async submitMappedEtimsStage(input: {
    readonly requestId: string;
    readonly configuration: unknown;
    readonly context: unknown;
    readonly calculationEvidence: unknown;
    readonly signal?: AbortSignal;
  }): Promise<
    | {
        readonly kind: "mapping_failed";
        readonly mapping: Extract<KraSalesMappingResult, { success: false }>;
      }
    | {
        readonly kind: "mapped";
        readonly mapping: Extract<KraSalesMappingResult, { success: true }>;
        readonly operation: EtimsReportingOperationDetails;
      }
  > {
    const record = await this.repository.findById(input.requestId);
    if (!record) throw new FiscalizationWorkflowRequestNotFoundError(input.requestId);
    if (!record.snapshot) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "source",
          errors: [
            { field: "snapshot", message: "A validated immutable invoice snapshot is required." },
          ],
        },
      };
    }
    let snapshot: FiscalizationSnapshot;
    try {
      snapshot = parseFiscalizationSnapshot(record.snapshot, record.snapshotVersion);
      if (snapshot.invoice.zohoInvoiceId !== record.zohoInvoiceId) {
        throw new Error("Snapshot identity mismatch");
      }
    } catch {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "source",
          errors: [
            {
              field: "snapshot",
              message: "The stored invoice snapshot failed integrity validation.",
            },
          ],
        },
      };
    }
    const validatedConfiguration = kraSalesMappingConfigurationSchema.safeParse(
      input.configuration,
    );
    const mapping = mapFiscalizationSnapshotToKraSalesRequest({
      snapshot,
      configuration: validatedConfiguration.success
        ? validatedConfiguration.data
        : input.configuration,
      context: input.context,
      calculationEvidence: input.calculationEvidence,
    });
    if (!mapping.success) return { kind: "mapping_failed", mapping };
    if (!validatedConfiguration.success) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "configuration",
          errors: [
            {
              field: "configuration",
              message:
                "Mapping configuration changed during validation; retry with a stable configuration value.",
            },
          ],
        },
      };
    }
    const selectedProvider = this.etims.getReadiness().selectedAdapterType;
    if (selectedProvider !== null && selectedProvider !== mapping.provider) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "configuration",
          errors: [
            {
              field: "configuration.provider",
              message: "Mapping provider does not match the explicitly selected eTIMS adapter.",
            },
          ],
        },
      };
    }
    const operation = await this.submitEtimsStage(
      input.requestId,
      mapping.request,
      input.signal,
      mapping.configurationDigest,
      validatedConfiguration.data,
    );
    return { kind: "mapped", mapping, operation };
  }

  async reconcileEtimsStage(
    requestId: string,
    payload: unknown,
  ): Promise<EtimsReportingOperationDetails> {
    const details = await this.etims.getByFiscalizationRequestId(requestId);
    if (!details) throw new FiscalizationWorkflowRequestNotFoundError(requestId);
    return this.etims.reconcile(details.operation.id, payload);
  }

  async getStatus(requestId: string): Promise<FiscalizationWorkflowStatus | null> {
    const fiscalization = await this.repository.findById(requestId);
    if (!fiscalization) return null;
    const [deviceAttempts, etims] = await Promise.all([
      this.repository.findAttemptsByRequestId?.(requestId) ?? Promise.resolve([]),
      this.etims.getByFiscalizationRequestId(requestId),
    ]);
    return { fiscalization, deviceAttempts, etims };
  }

  async execute(
    requestId: string,
    etimsPayload: unknown,
  ): Promise<{
    readonly state: "completed" | "blocked";
    readonly stages: readonly {
      readonly stage: FiscalizationWorkflowStage;
      readonly result: FiscalizationRecord | EtimsReportingOperationDetails;
    }[];
    readonly blockers: readonly string[];
  }> {
    const policy = this.workflowPolicy;
    if (!isValidWorkflowPolicy(policy)) {
      return { state: "blocked", stages: [], blockers: ["workflow_sequence_unverified"] };
    }

    const stages: {
      stage: FiscalizationWorkflowStage;
      result: FiscalizationRecord | EtimsReportingOperationDetails;
    }[] = [];
    for (const stage of policy.orderedStages) {
      const result =
        stage === "device"
          ? await this.processDeviceStage(requestId)
          : await this.submitEtimsStage(requestId, etimsPayload);
      stages.push({ stage, result });
      if (!policy.mayContinue(stage, result)) {
        return { state: "blocked", stages, blockers: [`${stage}_outcome_blocks_next_stage`] };
      }
    }
    return { state: "completed", stages, blockers: [] };
  }

  /** Maps an immutable source snapshot before running the explicitly configured stages. */
  async executeMapped(input: {
    readonly requestId: string;
    readonly configuration: unknown;
    readonly context: unknown;
    readonly calculationEvidence: unknown;
    readonly signal?: AbortSignal;
    readonly onStageStart?: (stage: FiscalizationWorkflowStage, simulated: boolean) => void;
  }): Promise<{
    readonly state: "completed" | "blocked" | "mapping_failed";
    readonly stages: readonly {
      readonly stage: FiscalizationWorkflowStage;
      readonly result: FiscalizationRecord | EtimsReportingOperationDetails;
    }[];
    readonly blockers: readonly string[];
    readonly mapping?: Extract<KraSalesMappingResult, { success: false }> | undefined;
    readonly simulated: boolean;
  }> {
    const policy = this.workflowPolicy;
    if (!isValidWorkflowPolicy(policy)) {
      return {
        state: "blocked",
        stages: [],
        blockers: ["workflow_sequence_unverified"],
        simulated: isSimulatedWorkflowPolicy(policy),
      };
    }
    const prepared = await this.mapEtimsRequest(input);
    if (prepared.kind === "mapping_failed") {
      return {
        state: "mapping_failed",
        stages: [],
        blockers: ["invoice_mapping_failed"],
        mapping: prepared.mapping,
        simulated: isSimulatedWorkflowPolicy(policy),
      };
    }

    const etimsOperation = await this.getOrRegisterEtimsOperation(
      input.requestId,
      prepared.mapping.request,
      prepared.mapping.configurationDigest,
    );
    const preflightBlockers = await this.etims.preflightSubmission(
      etimsOperation.operation.id,
      prepared.mapping.request,
      prepared.configuration,
    );
    if (preflightBlockers.length > 0) {
      return {
        state: "blocked",
        stages: [],
        blockers: preflightBlockers,
        simulated: isSimulatedWorkflowPolicy(policy),
      };
    }

    const stages: {
      stage: FiscalizationWorkflowStage;
      result: FiscalizationRecord | EtimsReportingOperationDetails;
    }[] = [];
    const current = await this.getStatus(input.requestId);
    if (!current) throw new FiscalizationWorkflowRequestNotFoundError(input.requestId);
    for (const stage of policy.orderedStages) {
      input.onStageStart?.(stage, isSimulatedWorkflowPolicy(policy));
      let result: FiscalizationRecord | EtimsReportingOperationDetails;
      if (stage === "device") {
        if (current.fiscalization.status === "Succeeded") {
          result = current.fiscalization;
        } else if (current.fiscalization.status === "Pending") {
          result = await this.processDeviceStage(input.requestId);
        } else {
          result = current.fiscalization;
        }
      } else {
        const known = await this.etims.getByFiscalizationRequestId(input.requestId);
        if (known && known.operation.status !== "pending") {
          result = known;
        } else {
          result = await this.submitEtimsStage(
            input.requestId,
            prepared.mapping.request,
            input.signal,
            prepared.mapping.configurationDigest,
            prepared.configuration,
          );
        }
      }
      stages.push({ stage, result });
      if (!policy.mayContinue(stage, result)) {
        return {
          state: "blocked",
          stages,
          blockers: [
            stage === "device" && "status" in result && result.status === "InProgress"
              ? "device_stage_requires_manual_review"
              : stage === "etims" &&
                  "operation" in result &&
                  (result.operation.status === "outcome_unknown" ||
                    result.operation.status === "reconciliation_required" ||
                    result.operation.status === "in_progress")
                ? "etims_stage_requires_manual_review"
                : `${stage}_outcome_blocks_next_stage`,
          ],
          simulated: isSimulatedWorkflowPolicy(policy),
        };
      }
    }
    return {
      state: "completed",
      stages,
      blockers: [],
      simulated: isSimulatedWorkflowPolicy(policy),
    };
  }

  private async mapEtimsRequest(input: {
    readonly requestId: string;
    readonly configuration: unknown;
    readonly context: unknown;
    readonly calculationEvidence: unknown;
  }): Promise<
    | {
        readonly kind: "mapping_failed";
        readonly mapping: Extract<KraSalesMappingResult, { success: false }>;
      }
    | {
        readonly kind: "mapped";
        readonly mapping: Extract<KraSalesMappingResult, { success: true }>;
        readonly configuration: unknown;
      }
  > {
    const record = await this.repository.findById(input.requestId);
    if (!record) throw new FiscalizationWorkflowRequestNotFoundError(input.requestId);
    if (!record.snapshot) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "source",
          errors: [{ field: "snapshot", message: "A validated invoice snapshot is required." }],
        },
      };
    }
    const validatedConfiguration = kraSalesMappingConfigurationSchema.safeParse(
      input.configuration,
    );
    const mapping = mapFiscalizationSnapshotToKraSalesRequest({
      snapshot: record.snapshot,
      configuration: validatedConfiguration.success
        ? validatedConfiguration.data
        : input.configuration,
      context: input.context,
      calculationEvidence: input.calculationEvidence,
    });
    if (!mapping.success) return { kind: "mapping_failed", mapping };
    if (!validatedConfiguration.success) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "configuration",
          errors: [{ field: "configuration", message: "Mapping configuration validation failed." }],
        },
      };
    }
    const selectedProvider = this.etims.getReadiness().selectedAdapterType;
    if (selectedProvider !== null && selectedProvider !== mapping.provider) {
      return {
        kind: "mapping_failed",
        mapping: {
          success: false,
          stage: "configuration",
          errors: [
            {
              field: "configuration.provider",
              message: "Mapping provider does not match the selected adapter.",
            },
          ],
        },
      };
    }
    return { kind: "mapped", mapping, configuration: validatedConfiguration.data };
  }
}

function isValidWorkflowPolicy(
  policy: FiscalizationWorkflowPolicy | undefined,
): policy is FiscalizationWorkflowPolicy {
  return Boolean(
    policy &&
    (("simulated" in policy && policy.simulated === true && policy.scenarioId.trim()) ||
      ("verificationReference" in policy && policy.verificationReference.trim())) &&
    new Set(policy.orderedStages).size === 2 &&
    policy.orderedStages.includes("device") &&
    policy.orderedStages.includes("etims"),
  );
}

function isSimulatedWorkflowPolicy(
  policy: FiscalizationWorkflowPolicy | undefined,
): policy is SimulatedFiscalizationWorkflowPolicy {
  return Boolean(policy && "simulated" in policy && policy.simulated === true);
}
