import { describe, expect, it, vi } from "vitest";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import type { EtimsReportingOperationDetails } from "../../src/domain/fiscalization/etims-reporting.js";
import type { ZohoFiscalizationWritebackOperation } from "../../src/domain/fiscalization/zoho-writeback.js";
import { ZohoFiscalizationWritebackService } from "../../src/application/zoho/zoho-fiscalization-writeback-service.js";
import type { ZohoFiscalizationWritebackRepository } from "../../src/application/zoho/zoho-fiscalization-writeback-repository.js";
import type { ZohoFiscalizationWritebackConfiguration } from "../../src/application/zoho/zoho-fiscalization-writeback-config.js";
import { makeFiscalizationSnapshot } from "./fiscalization-snapshot-fixture.js";
import { ZohoBooksWritebackError } from "../../src/integrations/zoho/books-client.js";

const requestId = "fiscal-request-1";
const invoiceId = "zoho-invoice-1";
const organizationId = "zoho-org-1";
const configuration: ZohoFiscalizationWritebackConfiguration = {
  statusFieldId: "400001",
  successStatusValue: "Fiscalized",
  deviceReceiptNumberFieldId: "400002",
  etimsReferenceFieldId: "400003",
  fiscalizedAtFieldId: "400004",
  requestIdFieldId: "400005",
};

async function makeRecord(
  overrides: Partial<FiscalizationRecord> = {},
): Promise<FiscalizationRecord> {
  const invoice = {
    zohoInvoiceId: invoiceId,
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Customer",
    currencyCode: "KES",
    lines: [
      {
        sourceLineId: "line-1",
        itemId: "item-1",
        description: "Product",
        quantity: "1",
        unitPrice: "10",
        lineTotal: "10",
        taxId: null,
        taxName: null,
        taxType: null,
        taxPercentage: null,
      },
    ],
    subtotal: "10",
    taxTotal: "0",
    total: "10",
  } as const;
  const snapshot = await makeFiscalizationSnapshot(invoice, organizationId);
  const record = createFiscalizationRecord({ id: requestId, zohoInvoiceId: invoiceId, snapshot });
  return {
    ...record,
    status: "Succeeded",
    outcomeProvenance: "authoritative",
    receipt: { receiptNumber: "CU-123", issuedAt: new Date("2026-10-27T10:00:00.000Z") },
    ...overrides,
  };
}

function createHarness(input: {
  readonly record: FiscalizationRecord;
  readonly etimsOverrides?: Partial<EtimsReportingOperationDetails["operation"]>;
  readonly initialFields?: Record<string, string>;
  readonly leaseMs?: number;
  readonly now?: () => Date;
  readonly update?: (fieldId: string, value: string) => Promise<void>;
}) {
  const stored = new Map<string, ZohoFiscalizationWritebackOperation>();
  let invoiceFields = { ...(input.initialFields ?? {}) };
  const written: Array<{ fieldId: string; value: string }> = [];
  const etimsOperation: EtimsReportingOperationDetails["operation"] = {
    id: "etims-op-1",
    fiscalizationRequestId: requestId,
    zohoInvoiceId: invoiceId,
    adapterType: "vscu",
    adapterConfigurationId: "provider-config-1",
    simulated: false,
    correlationId: "etims-correlation-1",
    status: "accepted",
    payloadHash: "a".repeat(64),
    attemptNumber: 1,
    reconciliationAttemptNumber: 0,
    providerReference: "KRA-REF-1",
    providerMetadataJson: null,
    errorCategory: null,
    errorMessage: null,
    reconciliationRequired: false,
    createdAt: new Date("2026-10-27T10:00:00.000Z"),
    updatedAt: new Date("2026-10-27T10:00:00.000Z"),
    ...input.etimsOverrides,
  };
  const etimsService = {
    getByFiscalizationRequestId: vi.fn(async () => ({ operation: etimsOperation, attempts: [] })),
  };
  const repository: ZohoFiscalizationWritebackRepository = {
    async findByFiscalizationRequestId(id) {
      return stored.get(id) ?? null;
    },
    async create(operation) {
      if (stored.has(operation.fiscalizationRequestId)) throw new Error("unique request");
      stored.set(operation.fiscalizationRequestId, operation);
    },
    async recordWrittenCustomField(id, fieldId, updatedAt) {
      const operation = [...stored.values()].find((value) => value.id === id);
      if (!operation || operation.status !== "in_progress") return false;
      if (!operation.writtenCustomFieldIds.includes(fieldId)) {
        stored.set(operation.fiscalizationRequestId, {
          ...operation,
          writtenCustomFieldIds: [...operation.writtenCustomFieldIds, fieldId],
          updatedAt,
        });
      }
      return true;
    },
    async transition(id, expectedStatus, next) {
      const operation = [...stored.values()].find((value) => value.id === id);
      if (!operation || operation.status !== expectedStatus) return false;
      stored.set(operation.fiscalizationRequestId, next);
      return true;
    },
  };
  const booksClient = {
    getOrganizationId: () => organizationId,
    getInvoice: vi.fn(async () => ({
      invoiceId,
      invoiceNumber: "INV-001",
      customerId: "customer-1",
      customerName: "Customer",
      currencyCode: "KES",
      source: {
        custom_fields: Object.entries(invoiceFields).map(([customfield_id, value]) => ({
          customfield_id,
          value,
        })),
      },
    })),
    updateInvoiceCustomField: vi.fn(async (_invoiceId: string, fieldId: string, value: string) => {
      written.push({ fieldId, value });
      if (input.update) await input.update(fieldId, value);
      invoiceFields = { ...invoiceFields, [fieldId]: value };
    }),
  };
  const fiscalizationRepository = { findById: vi.fn(async () => input.record) };
  const service = new ZohoFiscalizationWritebackService(
    fiscalizationRepository,
    etimsService as never,
    repository,
    booksClient as never,
    configuration,
    {
      ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs }),
      ...(input.now === undefined ? {} : { now: input.now }),
    },
  );
  return { service, stored, written, booksClient, etimsService };
}

describe("ZohoFiscalizationWritebackService", () => {
  it("writes only mapped custom fields for a persisted authoritative full success", async () => {
    const harness = createHarness({ record: await makeRecord() });

    const result = await harness.service.execute(requestId);

    expect(result).toMatchObject({ status: "succeeded", fieldsWritten: 5 });
    expect(harness.written.map((field) => field.fieldId)).toEqual([
      "400002",
      "400003",
      "400004",
      "400005",
      "400001",
    ]);
    expect(harness.written.at(-1)).toEqual({ fieldId: "400001", value: "Fiscalized" });
    expect(harness.booksClient.updateInvoiceCustomField).toHaveBeenCalledTimes(5);
  });

  it.each([
    ["simulated", { outcomeProvenance: "simulated" }],
    ["unverified", { outcomeProvenance: "unverified" }],
    ["failed", { status: "Failed", receipt: null }],
    ["uncertain", { status: "OutcomeUnknown", receipt: null }],
  ] as const)("does not write %s fiscalization outcomes", async (_name, overrides) => {
    const harness = createHarness({ record: await makeRecord(overrides) });
    const result = await harness.service.execute(requestId);

    expect(result.status).toBe("not_eligible");
    expect(harness.booksClient.updateInvoiceCustomField).not.toHaveBeenCalled();
  });

  it("blocks simulated, rejected, and partial eTIMS results", async () => {
    for (const etimsOverrides of [
      { simulated: true },
      { simulated: null },
      { status: "rejected" as const },
    ]) {
      const harness = createHarness({ record: await makeRecord(), etimsOverrides });
      expect((await harness.service.execute(requestId)).status).toBe("not_eligible");
      expect(harness.booksClient.updateInvoiceCustomField).not.toHaveBeenCalled();
    }
  });

  it("reconciles an uncertain prior writeback with GET and never resends its PUTs", async () => {
    let now = new Date("2026-10-27T10:00:00.000Z");
    const first = createHarness({
      record: await makeRecord(),
      leaseMs: 10_000,
      now: () => now,
      update: async () => {
        throw Object.assign(new Error("connection lost"), {
          name: "ZohoBooksWritebackError",
          category: "network_error",
          outcome: "outcome_unknown",
        });
      },
    });
    const result = await first.service.execute(requestId);
    expect(result.status).toBe("manual_review");
    expect(first.written).toHaveLength(1);

    now = new Date(now.getTime() + 11_000);
    const second = createHarness({
      record: await makeRecord(),
      initialFields: {
        "400002": "CU-123",
        "400003": "KRA-REF-1",
        "400004": "2026-10-27T10:00:00.000Z",
        "400005": requestId,
        "400001": "Fiscalized",
      },
      now: () => now,
    });
    // Reuse the durable operation produced by the first service.
    const operation = first.stored.get(requestId)!;
    second.stored.set(requestId, operation);
    const reconciled = await second.service.execute(requestId);
    expect(reconciled.status).toBe("succeeded");
    expect(second.booksClient.updateInvoiceCustomField).not.toHaveBeenCalled();
    expect(second.booksClient.getInvoice).toHaveBeenCalledOnce();
  });

  it("returns in-progress to concurrent callers and does not duplicate writes", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const harness = createHarness({ record: await makeRecord(), update: async () => wait });
    const first = harness.service.execute(requestId);
    await vi.waitFor(() =>
      expect(harness.booksClient.updateInvoiceCustomField).toHaveBeenCalledOnce(),
    );

    const competing = await harness.service.execute(requestId);
    expect(competing.status).toBe("in_progress");
    expect(harness.booksClient.updateInvoiceCustomField).toHaveBeenCalledOnce();

    release();
    await expect(first).resolves.toMatchObject({ status: "succeeded" });
  });

  it("returns persisted status without executing fiscalization", async () => {
    const harness = createHarness({ record: await makeRecord() });
    await harness.service.execute(requestId);
    const result = await harness.service.getStatus(requestId);

    expect(result).toMatchObject({ status: "succeeded", requestId });
    expect(harness.booksClient.updateInvoiceCustomField).toHaveBeenCalledTimes(5);
  });

  it("persists a definitive Zoho rejection and never repeats fiscalization or the writeback", async () => {
    const harness = createHarness({
      record: await makeRecord(),
      update: async () => {
        throw new ZohoBooksWritebackError("validation", "definitive_failure", 422);
      },
    });

    expect((await harness.service.execute(requestId)).status).toBe("failed");
    expect((await harness.service.execute(requestId)).status).toBe("failed");
    expect(harness.booksClient.updateInvoiceCustomField).toHaveBeenCalledOnce();
  });
});
