import { describe, expect, it, vi } from "vitest";

import { FiscalizationService } from "../../src/application/fiscalization/fiscalization-service.js";
import type { FiscalizationRepository } from "../../src/application/fiscalization/fiscalization-repository.js";
import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import { DuplicateZohoInvoiceError } from "../../src/application/fiscalization/fiscalization-errors.js";
import { startFiscalization } from "../../src/domain/fiscalization/fiscalization-operations.js";
import {
  createFiscalizationRecord,
  type FiscalizationRecord,
} from "../../src/domain/fiscalization/fiscalization-record.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import { makeFiscalizationSnapshot } from "./fiscalization-snapshot-fixture.js";

const invoice: FiscalInvoiceCandidate = {
  zohoInvoiceId: "pipeline-invoice-1",
  invoiceNumber: "INV-PIPE-1",
  customerId: "pipeline-customer-1",
  customerName: "Test Customer",
  currencyCode: "KES",
  lines: [
    {
      sourceLineId: "pipeline-line-1",
      itemId: "pipeline-item-1",
      description: "Test product",
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

function createInMemoryRepository() {
  const records = new Map<string, FiscalizationRecord>();
  const invoiceIds = new Set<string>();

  const repository: FiscalizationRepository = {
    findById: async (id) => records.get(id) ?? null,
    findByZohoInvoiceId: async (zohoInvoiceId) => {
      const record = [...records.values()].find((item) => item.zohoInvoiceId === zohoInvoiceId);
      return record ?? null;
    },
    create: async (record) => {
      if (invoiceIds.has(record.zohoInvoiceId)) {
        throw new DuplicateZohoInvoiceError(record.zohoInvoiceId);
      }
      records.set(record.id, record);
      invoiceIds.add(record.zohoInvoiceId);
    },
    claimPending: async (id) => {
      const current = records.get(id);
      if (!current || current.status !== "Pending") {
        return null;
      }
      const claimed = startFiscalization(current);
      records.set(id, claimed);
      return claimed;
    },
    saveOutcome: async (record) => {
      const current = records.get(record.id);
      if (!current || current.status !== "InProgress") {
        return false;
      }
      records.set(record.id, record);
      return true;
    },
    markStaleInProgressOutcomeUnknown: async () => 0,
  };

  return { repository, records };
}

describe("invoice-to-fiscalization workflow", () => {
  it("retrieves, validates, snapshots, registers, atomically claims, and persists one result", async () => {
    const { repository, records } = createInMemoryRepository();
    const invoiceService = {
      getFiscalInvoiceCandidate: vi.fn().mockResolvedValue({ success: true, candidate: invoice }),
    };
    const registration = new RegisterFiscalizationRequestService(repository);
    const preparation = new PrepareFiscalizationRequestService(invoiceService, registration, {
      zohoOrganizationId: "pipeline-organization",
      customerProfiles: {
        findByZohoCustomerId: async (zohoCustomerId) => ({
          id: "customer-profile",
          zohoCustomerId,
          companyName: "Test Company",
          clientPin: "P051234567X",
          headquarters: "Nairobi",
          address: "Test Road",
          postalCodeAndCity: "00100 Nairobi",
          exemptionNumber: null,
          createdAt: new Date("2026-10-27T00:00:00.000Z"),
          updatedAt: new Date("2026-10-27T00:00:00.000Z"),
        }),
      },
      itemProfiles: {
        findByZohoItemId: async (zohoItemId) => ({
          id: "item-profile",
          zohoItemId,
          measureUnit: "EA",
          hsCode: "1234.56.78",
          hsName: "Test product",
          vatClass: "A",
          vatGroupRate: "16",
          createdAt: new Date("2026-10-27T00:00:00.000Z"),
          updatedAt: new Date("2026-10-27T00:00:00.000Z"),
        }),
      },
      generateId: () => "pipeline-request-1",
      now: () => new Date("2026-10-27T00:00:00.000Z"),
    });

    const registered = await preparation.prepare(invoice.zohoInvoiceId);
    expect(registered.kind).toBe("registered");
    if (registered.kind !== "registered") {
      throw new Error("Expected valid invoice to be registered.");
    }

    const persistedSnapshot = records.get("pipeline-request-1")?.snapshot;
    expect(persistedSnapshot).toEqual(registered.record.snapshot);

    const changedLiveInvoice = { ...invoice, total: "999" };
    invoiceService.getFiscalInvoiceCandidate.mockResolvedValue({
      success: true,
      candidate: changedLiveInvoice,
    });
    const device = {
      issueReceipt: vi.fn().mockResolvedValue({
        kind: "succeeded",
        receipt: {
          receiptNumber: "TEST-RECEIPT-1",
          issuedAt: new Date("2026-10-27T00:01:00.000Z"),
        },
      }),
    };
    const processing = new FiscalizationService(repository, device, "pipeline-organization", {
      enabled: true,
      paymentSourceVerified: true,
      taxRulesVerified: true,
      deviceContractVerified: true,
    });

    const results = await Promise.allSettled([
      processing.fiscalize({ id: "pipeline-request-1" }),
      processing.fiscalize({ id: "pipeline-request-1" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(device.issueReceipt).toHaveBeenCalledOnce();
    expect(device.issueReceipt).toHaveBeenCalledWith(persistedSnapshot);
    expect(invoiceService.getFiscalInvoiceCandidate).toHaveBeenCalledOnce();
    expect(records.get("pipeline-request-1")?.status).toBe("Succeeded");
  });

  it("does not infer payment provenance from invoice data and blocks the processing path", async () => {
    const { repository, records } = createInMemoryRepository();
    const snapshot = await makeFiscalizationSnapshot(invoice, "pipeline-organization");
    const record = createFiscalizationRecord({
      id: "payment-prerequisite-request",
      zohoInvoiceId: invoice.zohoInvoiceId,
      snapshot,
    });
    records.set(record.id, record);
    const device = { issueReceipt: vi.fn() };
    const processing = new FiscalizationService(repository, device, "pipeline-organization");

    await expect(processing.fiscalize({ id: record.id })).rejects.toMatchObject({
      name: "FiscalizationIssuanceDisabledError",
      blockers: expect.arrayContaining([
        "payment_source_unverified",
        "tax_rules_unverified",
        "device_contract_unverified",
      ]),
    });

    expect(device.issueReceipt).not.toHaveBeenCalled();
    expect((await repository.findById(record.id))?.status).toBe("Pending");
  });
});
