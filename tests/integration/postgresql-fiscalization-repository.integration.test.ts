import "dotenv/config";

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { completeFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import { createPostgresqlClient } from "../../src/infrastructure/database/postgresql-client.js";
import { PostgresqlFiscalizationRepository } from "../../src/infrastructure/database/postgresql-fiscalization-repository.js";
import { PostgresqlFiscalCustomerProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-item-profile-repository.js";
import { PostgresqlZohoSyncRepository } from "../../src/infrastructure/database/postgresql-zoho-sync-repository.js";
import {
  EtimsReportingService,
  hashEtimsPayload,
} from "../../src/application/fiscalization/etims-reporting-service.js";
import type { EtimsReportingAdapter } from "../../src/application/fiscalization/etims-reporting-adapter.js";
import {
  AesGcmEtimsPayloadProtection,
  EtimsSubmissionPayloadVault,
} from "../../src/application/fiscalization/etims-submission-payload-vault.js";
import { PostgresqlEtimsReportingRepository } from "../../src/infrastructure/database/postgresql-etims-reporting-repository.js";
import { PostgresqlManualReviewRepository } from "../../src/infrastructure/database/postgresql-manual-review-repository.js";
import { PostgresqlZohoFiscalizationWritebackRepository } from "../../src/infrastructure/database/postgresql-zoho-writeback-repository.js";
import type { ZohoFiscalizationWritebackOperation } from "../../src/domain/fiscalization/zoho-writeback.js";
import { makeFiscalizationSnapshot } from "../unit/fiscalization-snapshot-fixture.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";

const integrationEnabled = process.env["RUN_POSTGRES_INTEGRATION"] === "1";
const integrationDescribe = integrationEnabled ? describe : describe.skip;

integrationDescribe("PostgreSQL fiscalization repository (integrations)", () => {
  const testInvoiceIds: string[] = [];
  const testCustomerIds: string[] = [];
  const testItemIds: string[] = [];
  const syncOrganizationIds: string[] = [];
  const syncRunIds: string[] = [];
  const etimsRequestIds: string[] = [];

  let prisma: ReturnType<typeof createPostgresqlClient>;
  let repository: PostgresqlFiscalizationRepository;
  let customerRepository: PostgresqlFiscalCustomerProfileRepository;
  let itemRepository: PostgresqlFiscalItemProfileRepository;
  let syncRepository: PostgresqlZohoSyncRepository;
  let etimsRepository: PostgresqlEtimsReportingRepository;
  let manualReviewRepository: PostgresqlManualReviewRepository;
  let writebackRepository: PostgresqlZohoFiscalizationWritebackRepository;

  function newRecord(zohoInvoiceId = `it-zoho-${randomUUID()}`) {
    testInvoiceIds.push(zohoInvoiceId);

    return createFiscalizationRecord({
      id: `it-record-${randomUUID()}`,
      zohoInvoiceId,
    });
  }

  beforeAll(async () => {
    const connectionString = process.env["ZOHO_FISCALIZATION_TEST_DATABASE_URL"];

    if (!connectionString) {
      throw new Error(
        "ZOHO_FISCALIZATION_TEST_DATABASE_URL is required to run PostgreSQL integration tests.",
      );
    }

    const parsedUrl = new URL(connectionString);

    // Guard against accidentally running these tests against another database.
    if (parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
      throw new Error("Integration tests are restricted to the local PostgreSQL database.");
    }

    if (parsedUrl.port !== "5438" || parsedUrl.pathname !== "/zoho_amarco_test") {
      throw new Error("Integration tests require zoho_amarco_test on localhost port 5438.");
    }

    prisma = createPostgresqlClient(connectionString);
    repository = new PostgresqlFiscalizationRepository(prisma);
    customerRepository = new PostgresqlFiscalCustomerProfileRepository(prisma);
    itemRepository = new PostgresqlFiscalItemProfileRepository(prisma);
    syncRepository = new PostgresqlZohoSyncRepository(prisma);
    etimsRepository = new PostgresqlEtimsReportingRepository(prisma);
    manualReviewRepository = new PostgresqlManualReviewRepository(prisma);
    writebackRepository = new PostgresqlZohoFiscalizationWritebackRepository(prisma);

    await prisma.$connect();
  });

  afterEach(async () => {
    if (etimsRequestIds.length > 0) {
      const operations = await prisma.etimsReportingOperation.findMany({
        where: { fiscalizationRequestId: { in: [...etimsRequestIds] } },
        select: { id: true },
      });
      const operationIds = operations.map((operation) => operation.id);
      if (operationIds.length > 0) {
        await prisma.etimsSubmissionPayload.deleteMany({
          where: { operationId: { in: operationIds } },
        });
        await prisma.etimsReportingAttempt.deleteMany({
          where: { operationId: { in: operationIds } },
        });
      }
      await prisma.etimsReportingOperation.deleteMany({
        where: { fiscalizationRequestId: { in: [...etimsRequestIds] } },
      });
      etimsRequestIds.length = 0;
    }
    // Delete only records created by this test suite, never the whole table.
    if (testInvoiceIds.length > 0) {
      const requests = await prisma.fiscalizationRecord.findMany({
        where: { zohoInvoiceId: { in: [...testInvoiceIds] } },
        select: { id: true },
      });
      await prisma.zohoFiscalizationWritebackOperation.deleteMany({
        where: { fiscalizationRequestId: { in: requests.map((row) => row.id) } },
      });
      const cases = await prisma.manualReviewCase.findMany({
        where: { fiscalizationRequestId: { in: requests.map((row) => row.id) } },
        select: { id: true },
      });
      if (cases.length > 0) {
        await prisma.manualReviewDecision.deleteMany({
          where: { caseId: { in: cases.map((row) => row.id) } },
        });
        await prisma.manualReviewCase.deleteMany({
          where: { id: { in: cases.map((row) => row.id) } },
        });
      }
      await prisma.fiscalizationRecord.deleteMany({
        where: { zohoInvoiceId: { in: [...testInvoiceIds] } },
      });
      testInvoiceIds.length = 0;
    }

    if (testCustomerIds.length > 0) {
      await prisma.fiscalCustomerProfile.deleteMany({
        where: { zohoCustomerId: { in: [...testCustomerIds] } },
      });
      testCustomerIds.length = 0;
    }

    if (testItemIds.length > 0) {
      await prisma.fiscalItemProfile.deleteMany({
        where: { zohoItemId: { in: [...testItemIds] } },
      });
      testItemIds.length = 0;
    }

    if (syncRunIds.length > 0) {
      await prisma.zohoSyncRun.deleteMany({ where: { id: { in: [...syncRunIds] } } });
      syncRunIds.length = 0;
    }

    if (syncOrganizationIds.length > 0) {
      await prisma.zohoSyncLock.deleteMany({
        where: { organizationId: { in: [...syncOrganizationIds] } },
      });
      syncOrganizationIds.length = 0;
    }
  });

  it("persists manual-review attempts and lets only one concurrent decision advance the audit sequence", async () => {
    const record = newRecord();
    await repository.create(record);
    const opened = await manualReviewRepository.openCase({
      id: `it-review-${randomUUID()}`,
      fiscalizationRequestId: record.id,
      operationId: `it-device-operation-${randomUUID()}`,
      relatedAttemptIds: ["attempt-one"],
      observedState: "OutcomeUnknown",
      reason: "Synthetic uncertain device operation",
      initiatingOperatorSubject: "operator-opened",
      createdAt: new Date(),
    });
    const inputs = [1, 2].map((n) => ({
      id: `it-decision-${randomUUID()}`,
      caseId: opened.id,
      operatorSubject: `operator-${n}`,
      requestedOutcome: "confirmed_success" as const,
      resolution: "operator_attested" as const,
      reason: "Synthetic test exercises competing terminal decisions",
      evidenceReference: null,
      recordedAt: new Date(),
    }));
    const results = await Promise.allSettled(
      inputs.map((input) => manualReviewRepository.recordDecision(input)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const reloaded = await manualReviewRepository.getCase(opened.id);
    expect(reloaded).toMatchObject({
      status: "resolved",
      operationId: opened.operationId,
      relatedAttemptIds: ["attempt-one"],
    });
    expect(reloaded?.decisions).toHaveLength(1);
    expect(reloaded?.decisions[0]?.resolution).toBe("operator_attested");
    expect(reloaded?.initiatingOperatorSubject).toBe("operator-opened");
    expect(reloaded?.resolvingOperatorSubject).toBe(reloaded?.decisions[0]?.operatorSubject);
    expect(reloaded?.resolvedAt).toEqual(reloaded?.decisions[0]?.recordedAt);
    const latest = reloaded!.decisions[0]!;
    const repeated = await manualReviewRepository.recordDecision({
      id: `it-retry-${randomUUID()}`,
      caseId: opened.id,
      operatorSubject: latest.operatorSubject,
      requestedOutcome: latest.requestedOutcome,
      resolution: latest.resolution,
      reason: latest.reason,
      evidenceReference: latest.evidenceReference,
      recordedAt: new Date(),
    });
    expect(repeated.decisions).toHaveLength(1);
  });

  it("persists synchronization history and enforces organization-scoped expiring leases", async () => {
    const organizationId = `it-sync-${randomUUID()}`;
    const runId = `it-sync-run-${randomUUID()}`;
    syncOrganizationIds.push(organizationId);
    syncRunIds.push(runId);
    const startedAt = new Date();
    const leaseExpiresAt = new Date(startedAt.getTime() + 60_000);

    const acquisitions = await Promise.all([
      syncRepository.tryAcquire(organizationId, "lease-first", startedAt, leaseExpiresAt),
      syncRepository.tryAcquire(organizationId, "lease-second", startedAt, leaseExpiresAt),
    ]);
    expect(acquisitions.filter(Boolean)).toHaveLength(1);
    const winningToken = acquisitions[0] ? "lease-first" : "lease-second";
    expect(acquisitions[0]).not.toBe(acquisitions[1]);
    await syncRepository.createRun({ id: runId, organizationId, startedAt });
    await syncRepository.completeRun(runId, {
      status: "Succeeded",
      completedAt: leaseExpiresAt,
      discovered: 3,
      imported: 2,
      duplicatesSkipped: 1,
      rejected: 0,
      failed: 0,
      pagesRetrieved: 1,
      paginationComplete: true,
      errorCode: null,
    });

    const status = await syncRepository.getLatest(organizationId);
    expect(status.run).toMatchObject({
      id: runId,
      status: "Succeeded",
      discovered: 3,
      imported: 2,
      paginationComplete: true,
    });
    expect(status.lastSuccessfulRun?.completedAt).toEqual(leaseExpiresAt);
    expect(
      await syncRepository.renew(
        organizationId,
        winningToken,
        leaseExpiresAt,
        new Date(leaseExpiresAt.getTime() + 60_000),
      ),
    ).toBe(false);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  it("enforces one fiscalization record per Zoho invoice", async () => {
    const original = newRecord();
    const duplicate = newRecord(original.zohoInvoiceId);

    await repository.create(original);

    await expect(repository.create(duplicate)).rejects.toBeInstanceOf(DuplicateZohoInvoiceError);

    const stored = await repository.findById(original.id);

    expect(stored?.zohoInvoiceId).toBe(original.zohoInvoiceId);
    expect(stored?.status).toBe("Pending");
  });

  it("persists writeback progress and allows only one durable operation per request", async () => {
    const record = newRecord();
    await repository.create(record);
    const now = new Date();
    const makeOperation = (id: string): ZohoFiscalizationWritebackOperation => ({
      id,
      fiscalizationRequestId: record.id,
      zohoInvoiceId: record.zohoInvoiceId,
      organizationId: "it-organization",
      correlationId: `it-correlation-${id}`,
      payloadHash: "a".repeat(64),
      status: "in_progress",
      writtenCustomFieldIds: [],
      errorCategory: null,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    const candidate = makeOperation(`it-writeback-${randomUUID()}`);
    const attempts = await Promise.allSettled([
      writebackRepository.create(candidate),
      writebackRepository.create(makeOperation(`it-writeback-${randomUUID()}`)),
    ]);

    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const persisted = await writebackRepository.findByFiscalizationRequestId(record.id);
    expect(persisted).not.toBeNull();
    expect(
      await writebackRepository.recordWrittenCustomField(persisted!.id, "460000000099001", now),
    ).toBe(true);
    expect(await writebackRepository.findByFiscalizationRequestId(record.id)).toMatchObject({
      id: persisted!.id,
      status: "in_progress",
      writtenCustomFieldIds: ["460000000099001"],
    });
  });

  it("persists and validates the immutable invoice snapshot", async () => {
    const invoiceId = `it-snapshot-${randomUUID()}`;
    testInvoiceIds.push(invoiceId);
    const invoice: FiscalInvoiceCandidate = {
      zohoInvoiceId: invoiceId,
      invoiceNumber: "SNAPSHOT-1",
      customerId: "customer-snapshot",
      customerName: "Snapshot customer",
      currencyCode: "KES",
      lines: [
        {
          sourceLineId: "line-1",
          itemId: "item-snapshot",
          description: "Snapshot item",
          quantity: "1",
          unitPrice: "100",
          lineTotal: "100",
          taxId: null,
          taxName: null,
          taxType: null,
          taxPercentage: null,
        },
      ],
      subtotal: "100",
      taxTotal: "0",
      total: "100",
    };
    const snapshot = await makeFiscalizationSnapshot(invoice);
    const record = createFiscalizationRecord({
      id: `it-record-${randomUUID()}`,
      zohoInvoiceId: invoiceId,
      snapshot,
    });

    await repository.create(record);
    const stored = await repository.findById(record.id);

    expect(stored?.snapshot).toEqual(snapshot);
    expect(stored?.snapshotVersion).toBe(snapshot.schemaVersion);
  });

  it("creates, reads, and updates fiscal customer and item profiles", async () => {
    const customerId = `it-customer-${randomUUID()}`;
    const itemId = `it-item-${randomUUID()}`;
    testCustomerIds.push(customerId);
    testItemIds.push(itemId);

    await customerRepository.create({
      zohoCustomerId: customerId,
      companyName: "Test Company",
      clientPin: "P051234567X",
      headquarters: "Nairobi",
      address: "Test Road",
      postalCodeAndCity: "00100 Nairobi",
      exemptionNumber: null,
    });
    await itemRepository.create({
      zohoItemId: itemId,
      measureUnit: "EA",
      hsCode: "1234.56.78",
      hsName: "Test item",
      vatClass: "A",
      vatGroupRate: "16",
    });

    expect(await customerRepository.findByZohoCustomerId(customerId)).toMatchObject({
      zohoCustomerId: customerId,
      companyName: "Test Company",
    });
    expect(await itemRepository.findByZohoItemId(itemId)).toMatchObject({
      zohoItemId: itemId,
      measureUnit: "EA",
    });

    expect(
      await customerRepository.update(customerId, {
        companyName: "Updated Company",
        clientPin: "P051234567X",
        headquarters: "Mombasa",
        address: "New Road",
        postalCodeAndCity: "80100 Mombasa",
        exemptionNumber: null,
      }),
    ).toMatchObject({ companyName: "Updated Company" });
    expect(
      await itemRepository.update(itemId, {
        measureUnit: "KG",
        hsCode: "1234.56.78",
        hsName: "Updated item",
        vatClass: "A",
        vatGroupRate: "16",
      }),
    ).toMatchObject({ measureUnit: "KG" });
  });

  it("allows only one concurrent worker to claim a Pending record", async () => {
    const record = newRecord();
    await repository.create(record);

    const results = await Promise.all([
      repository.claimPending(record.id),
      repository.claimPending(record.id),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);

    const stored = await repository.findById(record.id);
    expect(stored?.status).toBe("InProgress");
    const attempts = await repository.findAttemptsByRequestId(record.id);
    expect(attempts).toMatchObject([{ attemptNumber: 1, outcome: null, completedAt: null }]);
  });

  it("persists independent synthetic eTIMS submission and reconciliation attempts across service restart", async () => {
    const record = newRecord();
    await repository.create(record);
    etimsRequestIds.push(record.id);
    const payload = { synthetic: true, invoice: record.zohoInvoiceId };
    const submit = vi.fn().mockResolvedValue({
      kind: "outcome_unknown",
      errorCategory: "synthetic_timeout",
      safeMessage: "Synthetic provider timeout after possible acceptance.",
    });
    const reconcile = vi.fn().mockResolvedValue({
      kind: "accepted",
      providerReference: "SYNTHETIC-ETIMS-ACCEPTED",
      safeMetadataJson: '{"synthetic":true}',
    });
    const adapter: EtimsReportingAdapter = {
      status: {
        adapterType: "vscu",
        configured: true,
        contractVerified: true,
        operational: true,
        configurationId: "synthetic-test-only",
        blockers: [],
        capabilities: {
          supportsReconciliation: true,
          safeResubmissionAfterConfirmedNotFound: false,
        },
      },
      validate: vi.fn().mockResolvedValue([]),
      submit,
      reconcile,
    };
    const createService = () =>
      new EtimsReportingService(
        etimsRepository,
        [adapter],
        {
          enabled: true,
          selectedAdapterType: "vscu",
          verifiedReceiptLifecycle: true,
        },
        new EtimsSubmissionPayloadVault(
          etimsRepository,
          new AesGcmEtimsPayloadProtection("c".repeat(64)),
        ),
      );

    const operation = await createService().register({
      fiscalizationRequestId: record.id,
      zohoInvoiceId: record.zohoInvoiceId,
      payloadHash: hashEtimsPayload(payload),
    });
    expect(operation.adapterConfigurationId).toBe("synthetic-test-only");
    await expect(
      createService().register({
        fiscalizationRequestId: record.id,
        zohoInvoiceId: record.zohoInvoiceId,
        payloadHash: hashEtimsPayload(payload),
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await Promise.all([
      createService().submit(operation.id, payload),
      createService().submit(operation.id, payload),
    ]);
    expect(submit).toHaveBeenCalledOnce();
    const storedPayload = await etimsRepository.findSubmissionPayload(operation.id, 1);
    expect(storedPayload).toMatchObject({
      operationId: operation.id,
      fiscalizationRequestId: record.id,
      payloadVersion: 1,
      payloadHash: hashEtimsPayload(payload),
      submissionAttemptType: "submission",
      submissionAttemptNumber: 1,
    });
    expect(storedPayload?.encryptedPayload).not.toContain("integration-synthetic");
    const recoveredPayload = await new EtimsSubmissionPayloadVault(
      etimsRepository,
      new AesGcmEtimsPayloadProtection("c".repeat(64)),
    ).load((await etimsRepository.findById(operation.id))!, new AbortController().signal);
    expect(recoveredPayload).toEqual({ available: true, payload });
    expect((await etimsRepository.findById(operation.id))?.operation.status).toBe(
      "outcome_unknown",
    );
    expect(await etimsRepository.findReconciliationCandidates(10)).toMatchObject([
      { operation: { id: operation.id, status: "outcome_unknown", reconciliationRequired: true } },
    ]);

    // A new service instance has no in-memory operation state; it reloads by durable ID.
    const restartedService = createService();
    const resolved = await restartedService.reconcile(operation.id, payload);
    expect(resolved.operation).toMatchObject({ id: operation.id, status: "accepted" });
    expect(
      resolved.attempts.map(({ attemptType, outcome }) => [attemptType, outcome]).sort(),
    ).toEqual(
      [
        ["reconciliation", "accepted"],
        ["submission", "outcome_unknown"],
      ].sort(),
    );
    expect(submit).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(await etimsRepository.findReconciliationCandidates(10)).toEqual([]);
    await restartedService.submit(operation.id, payload);
    expect(submit).toHaveBeenCalledOnce();
    expect((await etimsRepository.findById(operation.id))?.operation.correlationId).toBe(
      operation.correlationId,
    );
  });

  it("persists a confirmed receipt and its Succeeded status", async () => {
    const record = newRecord();
    await repository.create(record);

    const claimed = await repository.claimPending(record.id);
    expect(claimed).not.toBeNull();

    if (!claimed) {
      throw new Error("Expected the Pending record to be claimed.");
    }

    const issuedAt = new Date("2026-10-24T08:30:00.000Z");

    const completed = completeFiscalization(claimed, {
      receiptNumber: "INTEGRATION-TEST-RECEIPT",
      issuedAt,
    });

    expect(await repository.saveOutcome(completed)).toBe(true);

    const stored = await repository.findById(record.id);

    expect(stored?.status).toBe("Succeeded");
    expect(stored?.receipt).toEqual({
      receiptNumber: "INTEGRATION-TEST-RECEIPT",
      issuedAt,
    });
    expect(await repository.findAttemptsByRequestId(record.id)).toMatchObject([
      {
        attemptNumber: 1,
        outcome: "succeeded",
        receiptNumber: "INTEGRATION-TEST-RECEIPT",
        issuedAt,
      },
    ]);
  });

  it("recovers stale requests without changing fresh or succeeded records", async () => {
    const staleRecord = newRecord();
    const freshRecord = newRecord();
    const succeededRecord = newRecord();

    await repository.create(staleRecord);
    await repository.create(freshRecord);
    await repository.create(succeededRecord);

    const staleClaim = await repository.claimPending(staleRecord.id);
    const freshClaim = await repository.claimPending(freshRecord.id);
    const succeededClaim = await repository.claimPending(succeededRecord.id);

    expect(staleClaim).not.toBeNull();
    expect(freshClaim).not.toBeNull();
    expect(succeededClaim).not.toBeNull();

    if (!staleClaim || !freshClaim || !succeededClaim) {
      throw new Error("Expected all three records to be claimed.");
    }

    const issuedAt = new Date("2026-10-24T08:30:00.000Z");

    const succeeded = completeFiscalization(succeededClaim, {
      receiptNumber: "RECOVERY-TEST-RECEIPT",
      issuedAt,
    });

    expect(await repository.saveOutcome(succeeded)).toBe(true);

    // Make only the first InProgress record stale.
    const staleBefore = new Date(Date.now() - 30_000);
    const staleUpdatedAt = new Date(staleBefore.getTime() - 1_000);

    await prisma.fiscalizationRecord.update({
      where: { id: staleRecord.id },
      data: { updatedAt: staleUpdatedAt },
    });

    const reason = "Integration test: stale processing recovery.";

    const recoveredCount = await repository.markStaleInProgressOutcomeUnknown(staleBefore, reason);

    expect(recoveredCount).toBe(1);

    const storedStale = await repository.findById(staleRecord.id);
    const storedFresh = await repository.findById(freshRecord.id);
    const storedSucceeded = await repository.findById(succeededRecord.id);

    expect(storedStale?.status).toBe("OutcomeUnknown");
    expect(storedStale?.outcomeUnknownReason).toBe(reason);
    expect(storedStale?.receipt).toBeNull();
    expect(await repository.findAttemptsByRequestId(staleRecord.id)).toMatchObject([
      { outcome: "outcome_unknown", errorCode: "stale_operation_recovered", errorMessage: reason },
    ]);

    expect(storedFresh?.status).toBe("InProgress");

    expect(storedSucceeded?.status).toBe("Succeeded");
    expect(storedSucceeded?.receipt).toEqual({
      receiptNumber: "RECOVERY-TEST-RECEIPT",
      issuedAt,
    });

    // Recovery is idempotent: the same record is not recovered twice.
    expect(await repository.markStaleInProgressOutcomeUnknown(staleBefore, reason)).toBe(0);
  });

  it("does not let a late outcome overwrite a recovered request", async () => {
    const record = newRecord();
    await repository.create(record);

    const claimed = await repository.claimPending(record.id);
    expect(claimed).not.toBeNull();

    if (!claimed) {
      throw new Error("Expected the Pending record to be claimed.");
    }

    const staleBefore = new Date(Date.now() - 30_000);

    await prisma.fiscalizationRecord.update({
      where: { id: record.id },
      data: {
        updatedAt: new Date(staleBefore.getTime() - 1_000),
      },
    });

    expect(
      await repository.markStaleInProgressOutcomeUnknown(
        staleBefore,
        "Integration test: device outcome requires reconciliation.",
      ),
    ).toBe(1);

    // Simulate the original worker receiving a late success response.
    const lateSuccess = completeFiscalization(claimed, {
      receiptNumber: "LATE-TEST-RECEIPT",
      issuedAt: new Date("2026-10-24T08:30:00.000Z"),
    });

    expect(await repository.saveOutcome(lateSuccess)).toBe(false);

    const stored = await repository.findById(record.id);

    expect(stored?.status).toBe("OutcomeUnknown");
    expect(stored?.receipt).toBeNull();
    expect(stored?.outcomeUnknownReason).toBe(
      "Integration test: device outcome requires reconciliation.",
    );
  });
});
