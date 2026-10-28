import { createHash, randomUUID } from "node:crypto";
import type { FiscalizationRepository } from "../fiscalization/fiscalization-repository.js";
import type { EtimsReportingService } from "../fiscalization/etims-reporting-service.js";
import type { ZohoBooksClient } from "../../integrations/zoho/books-client.js";
import { ZohoBooksWritebackError } from "../../integrations/zoho/books-client.js";
import type { ZohoFiscalizationWritebackOperation } from "../../domain/fiscalization/zoho-writeback.js";
import type { ZohoFiscalizationWritebackRepository } from "./zoho-fiscalization-writeback-repository.js";
import type { ZohoFiscalizationWritebackConfiguration } from "./zoho-fiscalization-writeback-config.js";

interface WritebackField {
  readonly id: string;
  readonly value: string;
}

export type ZohoFiscalizationWritebackResult =
  | {
      readonly status: "not_eligible";
      readonly requestId: string;
      readonly reason: string;
    }
  | {
      readonly status: ZohoFiscalizationWritebackOperation["status"] | "manual_review";
      readonly requestId: string;
      readonly correlationId: string;
      readonly fieldsWritten: number;
      readonly errorCategory: string | null;
    };

type WritebackResponseStatus = ZohoFiscalizationWritebackOperation["status"] | "manual_review";

export class ZohoFiscalizationWritebackNotFoundError extends Error {
  constructor() {
    super("Fiscalization request was not found.");
    this.name = "ZohoFiscalizationWritebackNotFoundError";
  }
}

/** Updates only configured Zoho invoice custom fields from persisted outcomes. */
export class ZohoFiscalizationWritebackService {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly fiscalizationRepository: Pick<FiscalizationRepository, "findById">,
    private readonly etimsService: Pick<EtimsReportingService, "getByFiscalizationRequestId">,
    private readonly repository: ZohoFiscalizationWritebackRepository,
    private readonly booksClient: Pick<
      ZohoBooksClient,
      "getOrganizationId" | "getInvoice" | "updateInvoiceCustomField"
    >,
    private readonly configuration: ZohoFiscalizationWritebackConfiguration,
    private readonly options: {
      readonly leaseMs?: number;
      readonly now?: () => Date;
      readonly createId?: () => string;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    const leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 10_000 || leaseMs > 120_000) {
      throw new Error("Zoho writeback lease must be between 10000 and 120000 milliseconds.");
    }
  }

  async getStatus(requestId: string): Promise<ZohoFiscalizationWritebackResult> {
    const operation = await this.repository.findByFiscalizationRequestId(requestId);
    if (!operation) {
      return { status: "not_eligible", requestId, reason: "writeback_not_started" };
    }
    return this.toResult(
      operation,
      operation.status === "outcome_unknown" ? "manual_review" : operation.status,
    );
  }

  async execute(requestIdInput: string): Promise<ZohoFiscalizationWritebackResult> {
    const requestId = requestIdInput.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestId)) {
      return { status: "not_eligible", requestId, reason: "invalid_request_id" };
    }
    const record = await this.fiscalizationRepository.findById(requestId);
    if (!record) throw new ZohoFiscalizationWritebackNotFoundError();
    const fields = await this.eligibleFields(record);
    if ("reason" in fields) return { status: "not_eligible", requestId, reason: fields.reason };

    const payloadHash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
    let operation = await this.repository.findByFiscalizationRequestId(requestId);
    let newlyCreated = false;
    if (!operation) {
      const createdAt = this.now();
      const leaseMs = this.options.leaseMs ?? 60_000;
      const candidate: ZohoFiscalizationWritebackOperation = {
        id: this.createId(),
        fiscalizationRequestId: requestId,
        zohoInvoiceId: record.zohoInvoiceId,
        organizationId: this.booksClient.getOrganizationId(),
        correlationId: this.createId(),
        payloadHash,
        status: "in_progress",
        writtenCustomFieldIds: [],
        errorCategory: null,
        leaseExpiresAt: new Date(createdAt.getTime() + leaseMs),
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
      };
      try {
        await this.repository.create(candidate);
        operation = candidate;
        newlyCreated = true;
      } catch {
        operation = await this.repository.findByFiscalizationRequestId(requestId);
        if (!operation) throw new Error("Could not create Zoho writeback operation.");
      }
    }

    if (
      operation.payloadHash !== payloadHash ||
      operation.organizationId !== this.booksClient.getOrganizationId()
    ) {
      return this.toResult(operation, "manual_review", "configuration_or_outcome_changed");
    }
    if (newlyCreated) return this.performUpdates(operation, fields);
    if (operation.status === "succeeded" || operation.status === "failed") {
      return this.toResult(operation, operation.status);
    }
    if (operation.status === "in_progress") {
      if (operation.leaseExpiresAt && operation.leaseExpiresAt > this.now()) {
        return this.toResult(operation, "in_progress");
      }
      const expired = this.withStatus(operation, "outcome_unknown", "lease_expired");
      if (!(await this.repository.transition(operation.id, "in_progress", expired))) {
        const latest = await this.repository.findByFiscalizationRequestId(requestId);
        return latest
          ? this.toResult(latest, "manual_review")
          : this.toResult(operation, "manual_review");
      }
      operation = expired;
    }
    return this.reconcile(operation, fields);
  }

  private async eligibleFields(
    record: NonNullable<Awaited<ReturnType<FiscalizationRepository["findById"]>>>,
  ): Promise<readonly WritebackField[] | { readonly reason: string }> {
    if (
      record.status !== "Succeeded" ||
      record.outcomeProvenance !== "authoritative" ||
      !record.receipt ||
      !record.snapshot ||
      record.snapshot.zohoOrganizationId !== this.booksClient.getOrganizationId() ||
      record.snapshot.invoice.zohoInvoiceId !== record.zohoInvoiceId
    ) {
      return { reason: "authoritative_device_success_required" };
    }
    const etims = await this.etimsService.getByFiscalizationRequestId(record.id);
    if (
      !etims ||
      etims.operation.status !== "accepted" ||
      etims.operation.simulated !== false ||
      etims.operation.zohoInvoiceId !== record.zohoInvoiceId
    ) {
      return { reason: "authoritative_etims_acceptance_required" };
    }

    const fields: WritebackField[] = [
      ...(this.configuration.deviceReceiptNumberFieldId
        ? [
            {
              id: this.configuration.deviceReceiptNumberFieldId,
              value: record.receipt.receiptNumber,
            },
          ]
        : []),
      ...(this.configuration.etimsReferenceFieldId && etims.operation.providerReference
        ? [
            {
              id: this.configuration.etimsReferenceFieldId,
              value: etims.operation.providerReference,
            },
          ]
        : []),
      ...(this.configuration.fiscalizedAtFieldId
        ? [
            {
              id: this.configuration.fiscalizedAtFieldId,
              value: record.receipt.issuedAt.toISOString(),
            },
          ]
        : []),
      ...(this.configuration.requestIdFieldId
        ? [{ id: this.configuration.requestIdFieldId, value: record.id }]
        : []),
      // Write the success marker last so it never precedes evidence fields.
      { id: this.configuration.statusFieldId, value: this.configuration.successStatusValue },
    ];
    return fields;
  }

  private async reconcile(
    operation: ZohoFiscalizationWritebackOperation,
    expected: readonly WritebackField[],
  ): Promise<ZohoFiscalizationWritebackResult> {
    try {
      const invoice = await this.booksClient.getInvoice(operation.zohoInvoiceId);
      const values = invoice.source["custom_fields"];
      if (Array.isArray(values)) {
        const current = new Map<string, string>();
        for (const item of values) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
          const field = item as Record<string, unknown>;
          const id = field["customfield_id"];
          const value = field["value"];
          if (typeof id === "string" && typeof value === "string") current.set(id, value);
        }
        if (expected.every(({ id, value }) => current.get(id) === value)) {
          const succeeded = this.withStatus(operation, "succeeded", null, this.now());
          if (await this.repository.transition(operation.id, "outcome_unknown", succeeded)) {
            return this.toResult(succeeded, "succeeded");
          }
          const latest = await this.repository.findByFiscalizationRequestId(
            operation.fiscalizationRequestId,
          );
          return latest
            ? this.toResult(latest, "manual_review")
            : this.toResult(operation, "manual_review");
        }
      }
    } catch {
      // GET errors cannot prove the prior PUT failed; retain uncertainty.
    }
    return this.toResult(
      operation,
      "manual_review",
      operation.errorCategory ?? "writeback_outcome_unknown",
    );
  }

  private async performUpdates(
    operation: ZohoFiscalizationWritebackOperation,
    fields: readonly WritebackField[],
  ): Promise<ZohoFiscalizationWritebackResult> {
    let written = operation;
    for (const field of fields) {
      try {
        await this.booksClient.updateInvoiceCustomField(
          written.zohoInvoiceId,
          field.id,
          field.value,
        );
      } catch (error: unknown) {
        const uncertain =
          !(error instanceof ZohoBooksWritebackError) || error.outcome === "outcome_unknown";
        const status =
          uncertain || written.writtenCustomFieldIds.length > 0 ? "outcome_unknown" : "failed";
        const category =
          error instanceof Error && "category" in error && typeof error.category === "string"
            ? error.category
            : "writeback_error";
        const terminal = this.withStatus(written, status, category, this.now());
        await this.repository.transition(written.id, "in_progress", terminal);
        return this.toResult(terminal, status === "outcome_unknown" ? "manual_review" : "failed");
      }
      if (!(await this.repository.recordWrittenCustomField(written.id, field.id, this.now()))) {
        const latest = await this.repository.findByFiscalizationRequestId(
          written.fiscalizationRequestId,
        );
        return latest
          ? this.toResult(latest, "manual_review")
          : this.toResult(written, "manual_review");
      }
      written = {
        ...written,
        writtenCustomFieldIds: [...written.writtenCustomFieldIds, field.id],
        updatedAt: this.now(),
      };
    }
    const succeeded = this.withStatus(written, "succeeded", null, this.now());
    if (!(await this.repository.transition(written.id, "in_progress", succeeded))) {
      const latest = await this.repository.findByFiscalizationRequestId(
        written.fiscalizationRequestId,
      );
      return latest
        ? this.toResult(latest, "manual_review")
        : this.toResult(written, "manual_review");
    }
    return this.toResult(succeeded, "succeeded");
  }

  private withStatus(
    operation: ZohoFiscalizationWritebackOperation,
    status: ZohoFiscalizationWritebackOperation["status"],
    errorCategory: string | null,
    now = this.now(),
  ): ZohoFiscalizationWritebackOperation {
    return {
      ...operation,
      status,
      errorCategory,
      leaseExpiresAt: status === "in_progress" ? operation.leaseExpiresAt : null,
      updatedAt: now,
      completedAt: status === "in_progress" ? null : now,
    };
  }

  private toResult(
    operation: ZohoFiscalizationWritebackOperation,
    status: WritebackResponseStatus,
    errorCategory: string | null = operation.errorCategory,
  ): ZohoFiscalizationWritebackResult {
    return {
      status,
      requestId: operation.fiscalizationRequestId,
      correlationId: operation.correlationId,
      fieldsWritten: operation.writtenCustomFieldIds.length,
      errorCategory,
    };
  }
}
