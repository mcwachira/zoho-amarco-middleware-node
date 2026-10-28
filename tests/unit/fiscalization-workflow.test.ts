import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import pino from "pino";
import { Writable } from "node:stream";

import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import { FiscalizationService } from "../../src/application/fiscalization/fiscalization-service.js";
import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import type {
  FiscalizationAttempt,
  FiscalizationRecord,
} from "../../src/domain/fiscalization/fiscalization-record.js";
import type {
  EtimsAdapterReconciliationResult,
  EtimsAdapterStatus,
  EtimsAdapterSubmissionResult,
  EtimsReportingAdapter,
  PreparedEtimsReportingRequest,
} from "../../src/application/fiscalization/etims-reporting-adapter.js";
import type {
  EtimsReportingAttempt,
  EtimsReportingOperation,
  EtimsReportingOperationDetails,
  EtimsReportingState,
} from "../../src/domain/fiscalization/etims-reporting.js";
import type { EtimsReportingRepository } from "../../src/application/fiscalization/etims-reporting-repository.js";
import { EtimsReportingService } from "../../src/application/fiscalization/etims-reporting-service.js";
import {
  AesGcmEtimsPayloadProtection,
  EtimsSubmissionPayloadVault,
} from "../../src/application/fiscalization/etims-submission-payload-vault.js";
import type {
  EtimsSubmissionPayloadClaim,
  EtimsSubmissionPayloadRecord,
} from "../../src/application/fiscalization/etims-submission-payload.js";
import { FiscalizationOrchestrationService } from "../../src/application/fiscalization/fiscalization-orchestration-service.js";
import type { FiscalizationWorkflowPolicy } from "../../src/application/fiscalization/fiscalization-orchestration-service.js";
import { SimulatedEtimsAdapter } from "../../src/infrastructure/etims/simulated-etims-adapter.js";
import { createApp } from "../../src/app.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import {
  TremolSimulator,
  SimulatedTremolFiscalDevice,
} from "../../src/infrastructure/device/tremol-simulator.js";
import { TremolFiscalDevice } from "../../src/infrastructure/device/tremol-fiscal-device.js";
import {
  syntheticCalculationEvidence,
  syntheticConfiguration,
  syntheticContext,
} from "./kra-sales-mapping-fixture.js";

const invoice: FiscalInvoiceCandidate = {
  zohoInvoiceId: "workflow-invoice-1",
  invoiceNumber: "INV-WORKFLOW-1",
  customerId: "customer-1",
  customerName: "Test Customer",
  currencyCode: "KES",
  subtotal: "100",
  taxTotal: "16",
  total: "116",
  lines: [
    {
      sourceLineId: "line-1",
      itemId: "item-1",
      description: "Test item",
      quantity: "1",
      unitPrice: "100",
      lineTotal: "100",
      taxId: "tax-1",
      taxName: "VAT",
      taxType: "tax",
      taxPercentage: "16",
    },
  ],
};
const org = "workflow-org";
const zohoInvoice = {
  invoiceId: invoice.zohoInvoiceId,
  invoiceNumber: invoice.invoiceNumber,
  customerId: invoice.customerId,
  customerName: invoice.customerName,
  currencyCode: invoice.currencyCode,
  source: {
    invoice_id: invoice.zohoInvoiceId,
    currency_code: "KES",
    line_items: [
      {
        line_item_id: "line-1",
        item_id: "item-1",
        name: "Test item",
        description: "Test item",
        quantity: 1,
        rate: 100,
        item_total: 100,
        tax_id: "tax-1",
        tax_name: "VAT",
        tax_type: "tax",
        tax_percentage: 16,
      },
    ],
    sub_total: 100,
    tax_total: 16,
    total: 116,
  },
};

const mockEtimsPayload = { invoiceId: invoice.zohoInvoiceId, kind: "synthetic-test-payload" };

class MemoryEtimsRepository implements EtimsReportingRepository {
  private readonly operations = new Map<string, EtimsReportingOperation>();
  private readonly attempts = new Map<string, EtimsReportingAttempt[]>();
  private readonly payloads = new Map<string, EtimsSubmissionPayloadRecord>();

  async create(operation: EtimsReportingOperation): Promise<void> {
    if (
      [...this.operations.values()].some(
        (item) => item.fiscalizationRequestId === operation.fiscalizationRequestId,
      )
    ) {
      throw new Error("Duplicate fiscalization request eTIMS operation.");
    }
    this.operations.set(operation.id, operation);
    this.attempts.set(operation.id, []);
  }

  async findById(id: string): Promise<EtimsReportingOperationDetails | null> {
    const operation = this.operations.get(id);
    return operation ? { operation, attempts: this.attempts.get(id) ?? [] } : null;
  }

  async findByFiscalizationRequestId(id: string): Promise<EtimsReportingOperationDetails | null> {
    const operation = [...this.operations.values()].find(
      (item) => item.fiscalizationRequestId === id,
    );
    return operation ? this.findById(operation.id) : null;
  }

  async findReconciliationCandidates(
    limit: number,
  ): Promise<readonly EtimsReportingOperationDetails[]> {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          operation.reconciliationRequired &&
          (operation.status === "outcome_unknown" ||
            operation.status === "reconciliation_required") &&
          operation.adapterType !== null,
      )
      .slice(0, limit)
      .map((operation) => ({ operation, attempts: this.attempts.get(operation.id) ?? [] }));
  }

  async claimPending(claim: EtimsSubmissionPayloadClaim): Promise<EtimsReportingOperation | null> {
    const { operationId: id, now } = claim;
    const current = this.operations.get(id);
    if (!current || current.status !== "pending") return null;
    if (claim.payload.operationId !== id || claim.payload.payloadHash !== current.payloadHash) {
      throw new Error("eTIMS payload association mismatch");
    }
    const claimed = {
      ...current,
      status: "in_progress" as const,
      attemptNumber: current.attemptNumber + 1,
      updatedAt: now,
    };
    this.operations.set(id, claimed);
    this.payloads.set(`${id}:${claim.payload.submissionAttemptNumber}`, claim.payload);
    this.attempts.get(id)?.push({
      id: `${id}:submission:${claimed.attemptNumber}`,
      operationId: id,
      attemptType: "submission",
      attemptNumber: claimed.attemptNumber,
      startedAt: now,
      completedAt: null,
      outcome: null,
      providerReference: null,
      errorCategory: null,
      errorMessage: null,
    });
    return claimed;
  }

  async findSubmissionPayload(
    id: string,
    attempt: number,
  ): Promise<EtimsSubmissionPayloadRecord | null> {
    return this.payloads.get(`${id}:${attempt}`) ?? null;
  }

  async claimReconciliation(
    id: string,
    expectedState: "outcome_unknown" | "reconciliation_required",
    now: Date,
  ): Promise<EtimsReportingOperation | null> {
    const current = this.operations.get(id);
    if (!current || current.status !== expectedState) return null;
    const claimed = {
      ...current,
      status: "reconciling" as const,
      reconciliationAttemptNumber: current.reconciliationAttemptNumber + 1,
      updatedAt: now,
    };
    this.operations.set(id, claimed);
    this.attempts.get(id)?.push({
      id: `${id}:reconciliation:${claimed.reconciliationAttemptNumber}`,
      operationId: id,
      attemptType: "reconciliation",
      attemptNumber: claimed.reconciliationAttemptNumber,
      startedAt: now,
      completedAt: null,
      outcome: null,
      providerReference: null,
      errorCategory: null,
      errorMessage: null,
    });
    return claimed;
  }

  async transition(
    id: string,
    expectedState: EtimsReportingState,
    operation: EtimsReportingOperation,
  ): Promise<boolean> {
    if (this.operations.get(id)?.status !== expectedState) return false;
    this.operations.set(id, operation);
    return true;
  }

  async completeAttempt(
    operation: EtimsReportingOperation,
    attempt: EtimsReportingAttempt,
  ): Promise<boolean> {
    const expected = attempt.attemptType === "submission" ? "in_progress" : "reconciling";
    if (this.operations.get(operation.id)?.status !== expected) return false;
    this.operations.set(operation.id, operation);
    this.attempts.set(
      operation.id,
      (this.attempts.get(operation.id) ?? []).map((item) =>
        item.attemptType === attempt.attemptType && item.attemptNumber === attempt.attemptNumber
          ? attempt
          : item,
      ),
    );
    return true;
  }

  async markStaleInProgressOutcomeUnknown(): Promise<number> {
    return 0;
  }
  async markStaleReconciliationRequired(): Promise<number> {
    return 0;
  }
}

class MockEtimsProvider implements EtimsReportingAdapter {
  readonly status: EtimsAdapterStatus = {
    adapterType: "vscu",
    configured: true,
    contractVerified: true,
    operational: true,
    configurationId: "synthetic-test-provider",
    blockers: [],
    capabilities: { supportsReconciliation: true, safeResubmissionAfterConfirmedNotFound: false },
  };
  submissionResult: EtimsAdapterSubmissionResult = {
    kind: "accepted",
    providerReference: "MOCK-ETIMS-ACCEPTED",
    safeMetadataJson: null,
  };
  reconciliationResult: EtimsAdapterReconciliationResult = { kind: "confirmed_not_found" };
  submissionCalls = 0;
  reconciliationCalls = 0;
  lastSubmissionRequest: PreparedEtimsReportingRequest | null = null;

  async validate(): Promise<readonly string[]> {
    return [];
  }
  async submit(request: PreparedEtimsReportingRequest): Promise<EtimsAdapterSubmissionResult> {
    this.submissionCalls += 1;
    this.lastSubmissionRequest = request;
    return this.submissionResult;
  }
  async reconcile(): Promise<EtimsAdapterReconciliationResult> {
    this.reconciliationCalls += 1;
    return this.reconciliationResult;
  }
}

function makeRepository() {
  const rows = new Map<string, FiscalizationRecord>();
  const attempts = new Map<string, FiscalizationAttempt[]>();
  const events: string[] = [];
  let failNextSave = false;
  const repository: FiscalizationRepository = {
    findById: async (id) => rows.get(id) ?? null,
    findByZohoInvoiceId: async (id) =>
      [...rows.values()].find((row) => row.zohoInvoiceId === id) ?? null,
    findAttemptsByRequestId: async (id) => attempts.get(id) ?? [],
    create: async (row) => {
      if ([...rows.values()].some((existing) => existing.zohoInvoiceId === row.zohoInvoiceId))
        throw new DuplicateZohoInvoiceError(row.zohoInvoiceId);
      rows.set(row.id, row);
      events.push("created");
    },
    claimPending: async (id) => {
      const current = rows.get(id);
      if (!current || current.status !== "Pending") return null;
      const claimed = startFiscalization(current);
      rows.set(id, claimed);
      attempts.set(id, [
        {
          id: `device-attempt:${id}:1`,
          fiscalizationRequestId: id,
          attemptNumber: 1,
          startedAt: claimed.updatedAt,
          completedAt: null,
          outcome: null,
          receiptNumber: null,
          issuedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      ]);
      events.push("claimed");
      return claimed;
    },
    saveOutcome: async (row) => {
      if (rows.get(row.id)?.status !== "InProgress") return false;
      if (failNextSave) {
        failNextSave = false;
        throw new Error("synthetic database failure after device result");
      }
      rows.set(row.id, row);
      attempts.set(
        row.id,
        (attempts.get(row.id) ?? []).map((attempt) => ({
          ...attempt,
          completedAt: row.updatedAt,
          outcome:
            row.status === "Succeeded"
              ? "succeeded"
              : row.status === "Failed"
                ? "failed"
                : "outcome_unknown",
          receiptNumber: row.receipt?.receiptNumber ?? null,
          issuedAt: row.receipt?.issuedAt ?? null,
          errorCode: row.failure?.code ?? null,
          errorMessage: row.failure?.message ?? row.outcomeUnknownReason,
        })),
      );
      events.push(`saved:${row.status}`);
      return true;
    },
    markStaleInProgressOutcomeUnknown: async (_staleBefore, reason) => {
      let count = 0;
      for (const [id, row] of rows) {
        if (row.status !== "InProgress") continue;
        const recovered = {
          ...row,
          status: "OutcomeUnknown" as const,
          outcomeUnknownReason: reason,
          updatedAt: new Date(),
        };
        rows.set(id, recovered);
        attempts.set(
          id,
          (attempts.get(id) ?? []).map((attempt) => ({
            ...attempt,
            completedAt: recovered.updatedAt,
            outcome: "outcome_unknown",
            errorCode: "stale_operation_recovered",
            errorMessage: reason,
          })),
        );
        count += 1;
      }
      return count;
    },
  };
  return {
    repository,
    rows,
    attempts,
    events,
    failNextOutcomeSave: () => {
      failNextSave = true;
    },
  };
}

function setup<T extends EtimsReportingAdapter = MockEtimsProvider>(
  provider: T = new MockEtimsProvider() as unknown as T,
  workflowPolicy?: FiscalizationWorkflowPolicy,
) {
  const { repository, rows, attempts, events, failNextOutcomeSave } = makeRepository();
  const payments = {
    getInvoicePayments: vi.fn(async () => ({
      page: 1,
      hasMore: false,
      payments: [
        {
          paymentId: "payment-1",
          paymentNumber: "PMT-1",
          paymentMode: "cash",
          amount: "116",
          date: "2026-10-27",
          referenceNumber: null,
          description: null,
          source: {},
        },
      ],
    })),
  };
  const books = { getInvoice: vi.fn(async () => zohoInvoice) };
  const invoiceService = new ZohoInvoiceService(books as never);
  const registration = new RegisterFiscalizationRequestService(repository);
  const profiles = {
    customerProfiles: {
      findByZohoCustomerId: vi.fn(async () => ({
        id: "customer-profile",
        zohoCustomerId: "customer-1",
        companyName: "Test Ltd",
        clientPin: "P051234567X",
        headquarters: "Nairobi",
        address: "Test Road",
        postalCodeAndCity: "00100 Nairobi",
        exemptionNumber: null,
        createdAt: new Date("2026-10-27T00:00:00Z"),
        updatedAt: new Date("2026-10-27T00:00:00Z"),
      })),
    },
    itemProfiles: {
      findByZohoItemId: vi.fn(async () => ({
        id: "item-profile",
        zohoItemId: "item-1",
        measureUnit: "EA",
        hsCode: "1234.56.78",
        hsName: "Test item",
        vatClass: "A",
        vatGroupRate: "16",
        createdAt: new Date("2026-10-27T00:00:00Z"),
        updatedAt: new Date("2026-10-27T00:00:00Z"),
      })),
    },
  };
  const prepare = new PrepareFiscalizationRequestService(invoiceService, registration, {
    zohoOrganizationId: org,
    ...profiles,
    paymentsClient: payments,
    generateId: () => "request-1",
    now: () => new Date("2026-10-27T01:00:00Z"),
  });
  const simulator = new TremolSimulator();
  const device = new SimulatedTremolFiscalDevice(simulator);
  const issuance = new FiscalizationService(repository, device, org, {
    enabled: true,
    paymentSourceVerified: true,
    taxRulesVerified: true,
    deviceContractVerified: true,
    simulated: true,
  });
  const etimsRepository = new MemoryEtimsRepository();
  const etimsVault = new EtimsSubmissionPayloadVault(
    etimsRepository,
    new AesGcmEtimsPayloadProtection("b".repeat(64)),
  );
  const etims = new EtimsReportingService(
    etimsRepository,
    [provider],
    {
      enabled: true,
      selectedAdapterType: "vscu",
      verifiedReceiptLifecycle: true,
      now: () => new Date("2026-10-27T03:00:00Z"),
      createId: (() => {
        let id = 0;
        return () => `mock-etims-id-${++id}`;
      })(),
    },
    etimsVault,
  );
  const orchestration = new FiscalizationOrchestrationService(
    repository,
    prepare,
    issuance,
    etims,
    workflowPolicy,
  );
  return {
    repository,
    rows,
    attempts,
    events,
    payments,
    books,
    profiles,
    prepare,
    simulator,
    device,
    issuance,
    provider,
    etimsRepository,
    etimsVault,
    etims,
    orchestration,
    failNextOutcomeSave,
  };
}

function mappingInputs(snapshotId: string) {
  const base = syntheticConfiguration("vscu");
  return {
    configuration: {
      ...base,
      itemMappings: base.itemMappings.map((item) => ({ ...item, sourceItemId: "item-1" })),
      taxMappings: base.taxMappings.map((tax) => ({ ...tax, sourceTaxId: "tax-1" })),
      paymentMappings: [{ sourcePaymentMethodId: "synthetic-payment-method-id", pmtTyCd: "SYN" }],
    },
    context: syntheticContext,
    calculationEvidence: {
      ...syntheticCalculationEvidence,
      snapshotId,
      payments: [{ paymentId: "payment-1", sourcePaymentMethodId: "synthetic-payment-method-id" }],
      lines: [
        {
          ...syntheticCalculationEvidence.lines[0]!,
          sourceLineId: "line-1",
          taxblAmt: "100",
          totTaxAmt: "16",
          totAmt: "116",
          prc: "100",
          splyAmt: "100",
        },
      ],
      buckets: {
        ...syntheticCalculationEvidence.buckets,
        A: { taxblAmt: "100", taxRt: "16", taxAmt: "16" },
      },
      totTaxblAmt: "100",
      totTaxAmt: "16",
      totAmt: "116",
    },
  };
}

function createCapturedWorkflowLogger(): { logger: pino.Logger; getOutput: () => string } {
  let output = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { logger: pino({ level: "info" }, stream), getOutput: () => output };
}

describe("fiscalization application workflow", () => {
  const simulatedPolicy = (
    orderedStages: readonly ["device" | "etims", "device" | "etims"],
  ): FiscalizationWorkflowPolicy => ({
    simulated: true,
    scenarioId: "unit-test",
    orderedStages,
    mayContinue: (stage, result) =>
      stage === "device"
        ? "status" in result && result.status === "Succeeded"
        : "operation" in result && result.operation.status === "accepted",
  });

  it("runs the complete simulated workflow through the authenticated Express API", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    h.simulator.setNextOutcome({
      kind: "success",
      receiptNumber: "HTTP-TEST-1",
      issuedAt: new Date("2026-10-27T03:00:00.000Z"),
    });
    const serviceToken = "api-test-service-token";
    const operatorToken = "api-test-operator-token";
    const capturedLogger = createCapturedWorkflowLogger();
    const app = createApp({
      requestLogger: capturedLogger.logger,
      invoiceApiBearerToken: serviceToken,
      operatorApiBearerToken: operatorToken,
      fiscalizationRepository: h.repository,
      prepareFiscalizationRequestService: h.prepare,
      fiscalizationService: h.issuance,
      fiscalizationOrchestrationService: h.orchestration,
      etimsReportingService: h.etims,
    });
    const invoicePath = `/integrations/zoho/invoices/${invoice.zohoInvoiceId}/fiscalization-requests`;

    const unauthenticated = await request(app).post(invoicePath).send({});
    expect(unauthenticated.status).toBe(401);
    const invalidAuthentication = await request(app)
      .post(invoicePath)
      .set("Authorization", "Bearer invalid-token")
      .send({});
    expect(invalidAuthentication.status).toBe(401);

    const intake = await request(app)
      .post(invoicePath)
      .set("Authorization", `Bearer ${serviceToken}`)
      .send({});
    expect(intake.status).toBe(201);
    expect(intake.body.request).toMatchObject({ id: "request-1", status: "Pending" });
    expect(intake.body.alreadyExisted).toBe(false);
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(0);
    const requestId = intake.body.request.id as string;
    const snapshotId = intake.body.request.snapshotId as string;
    expect(snapshotId).toMatch(/^[a-f0-9]{64}$/);

    const duplicate = await request(app)
      .post(invoicePath)
      .set("Authorization", `Bearer ${serviceToken}`)
      .send({});
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.alreadyExisted).toBe(true);
    expect(h.rows.size).toBe(1);

    const noOperatorPermission = await request(app)
      .post(`/integrations/zoho/fiscalization-requests/${requestId}/execute`)
      .set("Authorization", `Bearer ${serviceToken}`)
      .send({});
    expect(noOperatorPermission.status).toBe(403);
    const invalidRequest = await request(app)
      .post(`/integrations/zoho/fiscalization-requests/${requestId}/execute`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ configuration: {}, context: {} });
    expect(invalidRequest.status).toBe(400);

    const statusPath = `/integrations/zoho/fiscalization-requests/${requestId}`;
    const preExecutionStatus = await request(app)
      .get(statusPath)
      .set("Authorization", `Bearer ${serviceToken}`);
    const invalidMapping = await request(app)
      .post(`/integrations/zoho/fiscalization-requests/${requestId}/execute`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        configuration: {},
        context: syntheticContext,
        calculationEvidence: syntheticCalculationEvidence,
      });
    expect(invalidMapping.status).toBe(422);
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(0);

    const mapping = mappingInputs(snapshotId);
    const execution = await request(app)
      .post(`/integrations/zoho/fiscalization-requests/${requestId}/execute`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send(mapping);
    expect(execution.status).toBe(200);
    expect(execution.body).toMatchObject({
      state: "completed",
      simulated: true,
      stages: [
        { stage: "device", status: "Succeeded" },
        { stage: "etims", status: "accepted" },
      ],
    });

    const status = await request(app)
      .get(statusPath)
      .set("Authorization", `Bearer ${serviceToken}`);
    expect(status.status).toBe(200);
    expect(status.body.request).toMatchObject({
      status: "Succeeded",
      processingOutcome: { state: "simulated_success" },
      deviceSimulated: true,
      receipt: { receiptNumber: "SIM-HTTP-TEST-1" },
      integrations: { etims: "accepted", etimsSimulated: true },
      snapshot: { present: true, valid: true, snapshotId },
      deviceAttempts: [{ outcome: "succeeded", receiptNumber: "SIM-HTTP-TEST-1" }],
      operatorReviewRequired: false,
    });

    const persistedRequest = await h.repository.findById(requestId);
    const persistedEtims = await h.etims.getByFiscalizationRequestId(requestId);
    expect(persistedRequest?.status).toBe("Succeeded");
    expect(persistedRequest?.receipt?.receiptNumber).toBe("SIM-HTTP-TEST-1");
    expect(persistedEtims?.operation.status).toBe("accepted");
    expect(persistedEtims?.attempts[0]).toMatchObject({
      outcome: "accepted",
      providerReference: null,
    });
    expect(h.simulator.getCallCount()).toBe(1);
    expect(provider.getSubmissionCount()).toBe(1);
    expect(preExecutionStatus.status).toBe(200);
    expect(preExecutionStatus.body.request.status).toBe("Pending");
    const logOutput = capturedLogger.getOutput();
    expect(logOutput).toContain(requestId);
    expect(logOutput).toContain('"stage":"device"');
    expect(logOutput).toContain('"simulated":true');
    expect(logOutput).not.toContain(serviceToken);
    expect(logOutput).not.toContain(operatorToken);
    expect(logOutput).not.toContain("SYNTHETIC01");
  });

  it("executes a mapped device and simulated eTIMS success path in the explicit order", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    h.simulator.setNextOutcome({ kind: "success" });
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });

    expect(result).toMatchObject({ state: "completed", simulated: true, blockers: [] });
    expect(result.stages.map(({ stage }) => stage)).toEqual(["device", "etims"]);
    expect(h.simulator.getCallCount()).toBe(1);
    expect(provider.getSubmissionCount()).toBe(1);
    expect((await h.orchestration.getStatus(prepared.record.id))?.etims?.operation.status).toBe(
      "accepted",
    );
    expect((await h.repository.findById(prepared.record.id))?.receipt?.receiptNumber).toMatch(
      /^SIM-/,
    );
  });

  it("maps before any stage and never advances after an uncertain first result", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);
    h.simulator.setNextOutcome({ kind: "timeout" });

    const failedMapping = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      configuration: {},
      context: mapping.context,
      calculationEvidence: mapping.calculationEvidence,
    });
    expect(failedMapping.state).toBe("mapping_failed");
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(0);

    const uncertain = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    expect(uncertain.state).toBe("blocked");
    expect((await h.repository.findById(prepared.record.id))?.status).toBe("OutcomeUnknown");
    expect(provider.getSubmissionCount()).toBe(0);
    await expect(h.orchestration.processDeviceStage(prepared.record.id)).rejects.toMatchObject({
      name: "FiscalizationClaimError",
    });
    expect(h.simulator.getCallCount()).toBe(1);
  });

  it("blocks an invalid encrypted mapping archive before either simulated adapter is called", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const base = mappingInputs(prepared.record.snapshot!.snapshotId);
    const configuration = {
      ...base.configuration,
      itemMappings: [
        ...base.configuration.itemMappings,
        ...Array.from({ length: 9_999 }, (_, index) => ({
          ...base.configuration.itemMappings[0]!,
          sourceItemId: `unused-${index}`,
        })),
      ],
    };

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...base,
      configuration,
    });

    expect(result).toMatchObject({
      state: "blocked",
      stages: [],
      blockers: ["durable_submission_payload_invalid_or_unavailable"],
    });
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(0);
    expect(await h.etims.getByFiscalizationRequestId(prepared.record.id)).toMatchObject({
      operation: { status: "pending", attemptNumber: 0 },
      attempts: [],
    });
  });

  it("blocks a missing or invalid persisted invoice snapshot before simulated execution", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered" || !prepared.record.snapshot) {
      throw new Error("expected registration with immutable snapshot");
    }
    const validMapping = mappingInputs(prepared.record.snapshot.snapshotId);
    h.rows.set(prepared.record.id, {
      ...prepared.record,
      snapshot: null,
      snapshotVersion: null,
    });

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...validMapping,
    });

    expect(result.state).toBe("mapping_failed");
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(0);
  });

  it("runs the simulated eTIMS-first policy and prevents device execution after eTIMS uncertainty", async () => {
    const provider = new SimulatedEtimsAdapter("uncertain");
    const h = setup(provider, simulatedPolicy(["etims", "device"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    expect(result.state).toBe("blocked");
    expect(result.stages.map(({ stage }) => stage)).toEqual(["etims"]);
    expect(provider.getSubmissionCount()).toBe(1);
    expect(h.simulator.getCallCount()).toBe(0);
    expect((await h.orchestration.getStatus(prepared.record.id))?.etims?.operation.status).toBe(
      "outcome_unknown",
    );
  });

  it("resumes after restart from a known successful first stage without replaying it", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, {
      ...simulatedPolicy(["device", "etims"]),
      mayContinue: () => false,
    });
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);
    h.simulator.setNextOutcome({ kind: "success" });

    const interrupted = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    expect(interrupted.state).toBe("blocked");
    expect(provider.getSubmissionCount()).toBe(0);

    const restarted = new FiscalizationOrchestrationService(
      h.repository,
      h.prepare,
      h.issuance,
      h.etims,
      simulatedPolicy(["device", "etims"]),
    );
    const resumed = await restarted.executeMapped({ requestId: prepared.record.id, ...mapping });
    expect(resumed.state).toBe("completed");
    expect(h.simulator.getCallCount()).toBe(1);
    expect(provider.getSubmissionCount()).toBe(1);
  });

  it("preserves simulated eTIMS acceptance when the later device stage fails", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["etims", "device"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);
    h.simulator.setNextOutcome({ kind: "failure" });

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    const status = await h.orchestration.getStatus(prepared.record.id);
    expect(result.state).toBe("blocked");
    expect(status?.etims?.operation.status).toBe("accepted");
    expect(status?.fiscalization.status).toBe("Failed");
    expect(provider.getSubmissionCount()).toBe(1);
    expect(h.simulator.getCallCount()).toBe(1);
  });

  it("persists a simulated KRA rejection and does not run the later device stage", async () => {
    const provider = new SimulatedEtimsAdapter("rejected");
    const h = setup(provider, simulatedPolicy(["etims", "device"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    const status = await h.orchestration.getStatus(prepared.record.id);
    expect(result.state).toBe("blocked");
    expect(status?.etims?.operation.status).toBe("rejected");
    expect(h.simulator.getCallCount()).toBe(0);
    expect(provider.getSubmissionCount()).toBe(1);
  });

  it("classifies a simulated device adapter exception as uncertain and never submits eTIMS", async () => {
    const provider = new SimulatedEtimsAdapter("accepted");
    const h = setup(provider, simulatedPolicy(["device", "etims"]));
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const mapping = mappingInputs(prepared.record.snapshot!.snapshotId);
    h.simulator.setNextOutcome({ kind: "exception" });

    const result = await h.orchestration.executeMapped({
      requestId: prepared.record.id,
      ...mapping,
    });
    expect(result.state).toBe("blocked");
    expect((await h.repository.findById(prepared.record.id))?.status).toBe("OutcomeUnknown");
    expect(provider.getSubmissionCount()).toBe(0);
    expect(h.simulator.getCallCount()).toBe(1);
  });
  it("durably fails a claimed snapshot integrity error before any device call", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const originalClaimPending = h.repository.claimPending.bind(h.repository);
    vi.spyOn(h.repository, "claimPending").mockImplementation(async (id) => {
      const claimed = await originalClaimPending(id);
      if (!claimed?.snapshot) return claimed;
      return {
        ...claimed,
        snapshot: { ...claimed.snapshot, snapshotId: "a".repeat(64) },
      };
    });

    await expect(h.orchestration.processDeviceStage(prepared.record.id)).resolves.toMatchObject({
      status: "Failed",
      failure: { code: "INVALID_CLAIMED_SNAPSHOT" },
    });

    expect((await h.repository.findById(prepared.record.id))?.status).toBe("Failed");
    expect(await h.repository.findAttemptsByRequestId?.(prepared.record.id)).toMatchObject([
      { outcome: "failed", errorCode: "INVALID_CLAIMED_SNAPSHOT" },
    ]);
    expect(h.simulator.getCallCount()).toBe(0);
  });

  it("keeps the real Tremol adapter outside the claimed application path until readiness is verified", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const fetchImpl = vi.fn<typeof fetch>();
    const device = new TremolFiscalDevice({
      baseUrl: "http://localhost:4444",
      receiptIssuanceEnabled: true,
      fetchImpl,
    });
    const issuance = new FiscalizationService(h.repository, device, org, {
      enabled: true,
      paymentSourceVerified: true,
      taxRulesVerified: true,
      deviceContractVerified: true,
    });

    await expect(issuance.fiscalize({ id: prepared.record.id })).rejects.toMatchObject({
      name: "FiscalDeviceNotReadyError",
    });

    expect((await h.repository.findById(prepared.record.id))?.status).toBe("Pending");
    expect(await h.repository.findAttemptsByRequestId?.(prepared.record.id)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects mapping failures in application orchestration before registering or submitting eTIMS", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");

    const result = await h.orchestration.submitMappedEtimsStage({
      requestId: prepared.record.id,
      configuration: { schemaVersion: 99 },
      context: {},
      calculationEvidence: {},
    });

    expect(result.kind).toBe("mapping_failed");
    expect(h.provider.submissionCalls).toBe(0);
    expect(await h.etims.getByFiscalizationRequestId(prepared.record.id)).toBeNull();
  });

  it("maps a snapshot before durable eTIMS submission and binds the operation to the mapping digest", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered" || !prepared.record.snapshot) {
      throw new Error("expected an immutable snapshot");
    }
    const base = syntheticConfiguration("vscu");
    const configuration = {
      ...base,
      itemMappings: base.itemMappings.map((item) => ({ ...item, sourceItemId: "item-1" })),
      taxMappings: base.taxMappings.map((tax) => ({ ...tax, sourceTaxId: "tax-1" })),
      paymentMappings: [{ sourcePaymentMethodId: "synthetic-payment-method-id", pmtTyCd: "SYN" }],
    };
    const calculationEvidence = {
      ...syntheticCalculationEvidence,
      snapshotId: prepared.record.snapshot.snapshotId,
      payments: [
        {
          paymentId: "payment-1",
          sourcePaymentMethodId: "synthetic-payment-method-id",
        },
      ],
      lines: [
        {
          ...syntheticCalculationEvidence.lines[0]!,
          sourceLineId: "line-1",
          taxblAmt: "100",
          totTaxAmt: "16",
          totAmt: "116",
          prc: "100",
          splyAmt: "100",
        },
      ],
      buckets: {
        ...syntheticCalculationEvidence.buckets,
        A: { taxblAmt: "100", taxRt: "16", taxAmt: "16" },
      },
      totTaxblAmt: "100",
      totTaxAmt: "16",
      totAmt: "116",
    };

    const result = await h.orchestration.submitMappedEtimsStage({
      requestId: prepared.record.id,
      configuration,
      context: syntheticContext,
      calculationEvidence,
    });
    expect(result.kind).toBe("mapped");
    if (result.kind !== "mapped") throw new Error("expected structural mapping");
    expect(result.operation.operation.status).toBe("accepted");
    expect(h.provider.lastSubmissionRequest?.payload).toMatchObject({
      tin: "SYNTHETIC01",
      trdInvcNo: "SYNTHETIC-TRADER-INVOICE",
      salesTyCd: "N",
      itemList: [{ itemSeq: 1, itemCd: "SYNITEM", qty: 1, prc: 100 }],
    });
    expect(result.operation.operation.adapterConfigurationId).toContain(
      `mapping-sha256:${result.mapping.configurationDigest}`,
    );
    await expect(
      h.etimsVault.loadHistoricalMappingConfiguration(result.operation),
    ).resolves.toMatchObject({
      available: true,
      configuration,
      digest: result.mapping.configurationDigest,
    });
    expect(h.provider.submissionCalls).toBe(1);

    await expect(
      h.orchestration.submitMappedEtimsStage({
        requestId: prepared.record.id,
        configuration: { ...configuration, configurationId: "changed-version" },
        context: syntheticContext,
        calculationEvidence,
      }),
    ).rejects.toThrow("different mapping configuration");
    expect(h.provider.submissionCalls).toBe(1);
  });

  it("blocks mapped submission if encrypted configuration archival exceeds the vault limit", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered" || !prepared.record.snapshot) {
      throw new Error("expected an immutable snapshot");
    }
    const base = syntheticConfiguration("vscu");
    const configuration = {
      ...base,
      itemMappings: [
        ...base.itemMappings.map((item) => ({ ...item, sourceItemId: "item-1" })),
        ...Array.from({ length: 9_999 }, (_, index) => ({
          ...base.itemMappings[0]!,
          sourceItemId: `synthetic-unused-item-${index}`,
        })),
      ],
      taxMappings: base.taxMappings.map((tax) => ({ ...tax, sourceTaxId: "tax-1" })),
      paymentMappings: [{ sourcePaymentMethodId: "synthetic-payment-method-id", pmtTyCd: "SYN" }],
    };
    const calculationEvidence = {
      ...syntheticCalculationEvidence,
      snapshotId: prepared.record.snapshot.snapshotId,
      payments: [
        {
          paymentId: "payment-1",
          sourcePaymentMethodId: "synthetic-payment-method-id",
        },
      ],
      lines: [
        {
          ...syntheticCalculationEvidence.lines[0]!,
          sourceLineId: "line-1",
          taxblAmt: "100",
          totTaxAmt: "16",
          totAmt: "116",
          prc: "100",
          splyAmt: "100",
        },
      ],
      buckets: {
        ...syntheticCalculationEvidence.buckets,
        A: { taxblAmt: "100", taxRt: "16", taxAmt: "16" },
      },
      totTaxblAmt: "100",
      totTaxAmt: "16",
      totAmt: "116",
    };

    const result = await h.orchestration.submitMappedEtimsStage({
      requestId: prepared.record.id,
      configuration,
      context: syntheticContext,
      calculationEvidence,
    });
    if (result.kind !== "mapped") throw new Error(JSON.stringify(result.mapping));
    expect(h.provider.submissionCalls).toBe(0);
    await expect(h.etims.getByFiscalizationRequestId(prepared.record.id)).resolves.toMatchObject({
      operation: {
        status: "blocked",
        errorCategory: "durable_submission_payload_invalid_or_unavailable",
      },
    });
  });

  it("retrieves evidence, snapshots, atomically registers and claims, then records independent mock outcomes", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    expect(prepared.kind).toBe("registered");
    if (prepared.kind !== "registered") throw new Error("expected registration");
    expect(h.books.getInvoice).toHaveBeenCalledOnce();
    expect(h.payments.getInvoicePayments).toHaveBeenCalledWith(invoice.zohoInvoiceId, undefined, 1);
    expect(prepared.record.snapshot?.payments).toHaveLength(1);
    expect(prepared.record.status).toBe("Pending");
    expect(h.events).toEqual(["created"]);
    expect(await h.device.checkReadiness()).toEqual({ ready: true });

    // Duplicate preparation cannot create a second request for the same invoice.
    await expect(h.prepare.prepare(invoice.zohoInvoiceId)).rejects.toBeInstanceOf(
      DuplicateZohoInvoiceError,
    );
    expect(h.rows.size).toBe(1);

    h.simulator.setNextOutcome({
      kind: "success",
      receiptNumber: "SIM-WORKFLOW-0001",
      issuedAt: new Date("2026-10-27T02:00:00Z"),
    });
    const result = await h.orchestration.processDeviceStage(prepared.record.id);
    expect(result.status).toBe("Succeeded");
    expect(result.receipt?.receiptNumber).toMatch(/^SIM-/);
    expect(h.events).toEqual(["created", "claimed", "saved:Succeeded"]);

    const etimsResult = await h.orchestration.submitEtimsStage(
      prepared.record.id,
      mockEtimsPayload,
    );
    expect(etimsResult.operation).toMatchObject({
      status: "accepted",
      providerReference: "MOCK-ETIMS-ACCEPTED",
    });
    expect(etimsResult.attempts).toMatchObject([
      { attemptType: "submission", outcome: "accepted" },
    ]);
    expect(h.provider.submissionCalls).toBe(1);
    const status = await h.orchestration.getStatus(prepared.record.id);
    expect(status?.fiscalization).toMatchObject({
      status: "Succeeded",
      receipt: { receiptNumber: "SIM-WORKFLOW-0001" },
    });
    expect(status?.etims?.operation).toMatchObject({
      id: etimsResult.operation.id,
      status: "accepted",
    });

    // Replaying either stage does not call either external boundary a second time.
    await expect(h.orchestration.processDeviceStage(prepared.record.id)).rejects.toMatchObject({
      name: "FiscalizationClaimError",
    });
    await h.orchestration.submitEtimsStage(prepared.record.id, mockEtimsPayload);
    expect(h.simulator.getCallCount()).toBe(1);
    expect(h.provider.submissionCalls).toBe(1);
  });

  it("allows one concurrent claimant and does not repeat an uncertain device operation", async () => {
    const h = setup();
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    h.simulator.setNextOutcome({ kind: "timeout" });
    const first = h.orchestration.processDeviceStage(prepared.record.id);
    await vi.waitFor(() => expect(h.simulator.getCallCount()).toBe(1));
    await expect(h.issuance.fiscalize({ id: prepared.record.id })).rejects.toMatchObject({
      name: "FiscalizationClaimError",
    });
    const result = await first;
    expect(result.status).toBe("OutcomeUnknown");
    expect(h.simulator.getCallCount()).toBe(1);
    expect(await h.repository.claimPending(prepared.record.id)).toBeNull();
    expect(h.attempts.get(prepared.record.id)).toMatchObject([
      {
        attemptNumber: 1,
        outcome: "outcome_unknown",
        errorMessage: "Simulated receipt issuance timed out",
      },
    ]);
  });

  it("persists device rejection without creating or implying an eTIMS result", async () => {
    const provider = new MockEtimsProvider();
    provider.submissionResult = {
      kind: "rejected",
      errorCategory: "mock_rejection",
      safeMessage: "Synthetic provider rejection",
      providerReference: null,
      safeMetadataJson: null,
    };
    const h = setup(provider);
    const prepared = await h.prepare.prepare(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    h.simulator.setNextOutcome({
      kind: "failure",
      failureCode: "SIM-PAPER",
      failureMessage: "Simulated paper error",
    });
    const result = await h.orchestration.processDeviceStage(prepared.record.id);
    expect(result).toMatchObject({
      status: "Failed",
      failure: { code: "SIM-PAPER" },
      receipt: null,
    });
    const statusBeforeReporting = await h.orchestration.getStatus(prepared.record.id);
    expect(statusBeforeReporting?.etims).toBeNull();
    expect(h.provider.submissionCalls).toBe(0);
  });

  it("keeps device success when the explicit mock eTIMS provider rejects or times out", async () => {
    for (const result of [
      {
        kind: "rejected",
        errorCategory: "mock_rejected",
        safeMessage: "Synthetic rejection",
        providerReference: null,
        safeMetadataJson: null,
      },
      { kind: "outcome_unknown", errorCategory: "mock_timeout", safeMessage: "Synthetic timeout" },
    ] as const) {
      const provider = new MockEtimsProvider();
      provider.submissionResult = result;
      const h = setup(provider);
      const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
      if (prepared.kind !== "registered") throw new Error("expected registration");
      h.simulator.setNextOutcome({
        kind: "success",
        receiptNumber: "SIM-INDEPENDENT-1",
        issuedAt: new Date("2026-10-27T02:00:00Z"),
      });
      const device = await h.orchestration.processDeviceStage(prepared.record.id);
      const etims = await h.orchestration.submitEtimsStage(prepared.record.id, mockEtimsPayload);
      const status = await h.orchestration.getStatus(prepared.record.id);
      expect(device.status).toBe("Succeeded");
      expect(status?.fiscalization.status).toBe("Succeeded");
      expect(etims.operation.status).toBe(
        result.kind === "rejected" ? "rejected" : "outcome_unknown",
      );
      expect(etims.operation.fiscalizationRequestId).toBe(prepared.record.id);
      expect(etims.attempts).toHaveLength(1);
      expect(
        etims.operation.status === "outcome_unknown"
          ? etims.operation.reconciliationRequired
          : false,
      ).toBe(result.kind === "outcome_unknown");
      expect(h.simulator.getCallCount()).toBe(1);
    }
  });

  it("records reconciliation attempts with the original operation ID and never resubmits an unknown eTIMS request", async () => {
    const provider = new MockEtimsProvider();
    provider.submissionResult = {
      kind: "outcome_unknown",
      errorCategory: "mock_timeout",
      safeMessage: "Synthetic timeout",
    };
    provider.reconciliationResult = {
      kind: "accepted",
      providerReference: "MOCK-RECONCILED",
      safeMetadataJson: null,
    };
    const h = setup(provider);
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    const first = await h.orchestration.submitEtimsStage(prepared.record.id, mockEtimsPayload);
    const operationId = first.operation.id;
    expect(first.operation.status).toBe("outcome_unknown");
    const duplicate = await h.orchestration.submitEtimsStage(prepared.record.id, mockEtimsPayload);
    expect(duplicate.operation.id).toBe(operationId);
    expect(provider.submissionCalls).toBe(1);

    const reconciled = await h.orchestration.reconcileEtimsStage(
      prepared.record.id,
      mockEtimsPayload,
    );
    expect(reconciled.operation).toMatchObject({
      id: operationId,
      status: "accepted",
      reconciliationAttemptNumber: 1,
    });
    expect(reconciled.attempts).toMatchObject([
      { attemptType: "submission", outcome: "outcome_unknown" },
      { attemptType: "reconciliation", outcome: "accepted" },
    ]);
    expect(provider.submissionCalls).toBe(1);
    expect(provider.reconciliationCalls).toBe(1);
  });

  it("blocks the combined workflow while its legal device/eTIMS ordering is unverified", async () => {
    const h = setup();
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");

    const result = await h.orchestration.execute(prepared.record.id, mockEtimsPayload);

    expect(result).toEqual({
      state: "blocked",
      stages: [],
      blockers: ["workflow_sequence_unverified"],
    });
    expect(h.simulator.getCallCount()).toBe(0);
    expect(h.provider.submissionCalls).toBe(0);
  });

  it("leaves the request pending when simulated device readiness fails", async () => {
    const h = setup();
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    h.simulator.setConnected(false);

    await expect(h.orchestration.processDeviceStage(prepared.record.id)).rejects.toMatchObject({
      name: "FiscalDeviceNotReadyError",
    });

    expect((await h.repository.findById(prepared.record.id))?.status).toBe("Pending");
    expect(await h.repository.findAttemptsByRequestId?.(prepared.record.id)).toEqual([]);
    expect(h.simulator.getCallCount()).toBe(0);
  });

  it("recovers a failed outcome save after restart without repeating the possible device operation", async () => {
    const h = setup();
    const prepared = await h.orchestration.prepareInvoice(invoice.zohoInvoiceId);
    if (prepared.kind !== "registered") throw new Error("expected registration");
    h.simulator.setNextOutcome({
      kind: "success",
      receiptNumber: "SIM-PERSISTENCE-UNCERTAIN",
      issuedAt: new Date("2026-10-27T02:00:00Z"),
    });
    h.failNextOutcomeSave();
    await expect(h.orchestration.processDeviceStage(prepared.record.id)).rejects.toMatchObject({
      name: "FiscalizationPersistenceError",
    });
    expect(h.simulator.getCallCount()).toBe(1);

    // A restarted recovery worker can only mark uncertainty; it cannot issue a second receipt.
    await h.repository.markStaleInProgressOutcomeUnknown(
      new Date("2026-10-27T04:00:00Z"),
      "Recovered after a synthetic process interruption.",
    );
    const restartedOrchestrator = new FiscalizationOrchestrationService(
      h.repository,
      h.prepare,
      h.issuance,
      h.etims,
    );
    const status = await restartedOrchestrator.getStatus(prepared.record.id);
    expect(status?.fiscalization).toMatchObject({ status: "OutcomeUnknown", receipt: null });
    expect(status?.deviceAttempts).toMatchObject([{ outcome: "outcome_unknown" }]);
    await expect(
      restartedOrchestrator.processDeviceStage(prepared.record.id),
    ).rejects.toMatchObject({ name: "FiscalizationClaimError" });
    expect(h.simulator.getCallCount()).toBe(1);
  });
});
