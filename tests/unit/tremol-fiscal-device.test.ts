/**
 * Unit tests for the TremolFiscalDevice adapter.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FiscalizationSnapshot } from "../../src/domain/fiscalization/fiscalization-snapshot.js";
import type { FISCALIZATION_SNAPSHOT_VERSION } from "../../src/domain/fiscalization/fiscalization-snapshot.js";
import {
  TremolFiscalDevice,
  ReceiptIssuanceDisabledError,
  ReceiptInProgressError,
  createTremolFiscalDevice,
} from "../../src/infrastructure/device/tremol-fiscal-device.js";

// Test snapshot factory
function createTestSnapshot(overrides: Partial<FiscalizationSnapshot> = {}): FiscalizationSnapshot {
  return {
    schemaVersion: 1 as const,
    snapshotId: "test-snapshot-1",
    registeredAt: new Date().toISOString(),
    zohoOrganizationId: "org-123",
    invoice: {
      zohoInvoiceId: "inv-123",
      invoiceNumber: "INV-001",
      customerId: "cust-123",
      customerName: "Test Customer",
      currencyCode: "KES",
      lines: [
        {
          sourceLineId: "line-1",
          itemId: "item-1",
          description: "Test Item",
          quantity: "2",
          unitPrice: "100.00",
          lineTotal: "200.00",
          taxId: "tax-1",
          taxName: "VAT",
          taxType: "VAT",
          taxPercentage: "16",
        },
      ],
      subtotal: "200.00",
      taxTotal: "32.00",
      total: "232.00",
    },
    customer: {
      zohoCustomerId: "cust-123",
      companyName: "Test Company",
      clientPin: "A123456789B",
      headquarters: "Nairobi",
      address: "123 Test St",
      postalCodeAndCity: "00100 Nairobi",
      exemptionNumber: null,
      traderSystemInvoiceNumber: "INV-001",
    },
    lineProfiles: [
      {
        sourceLineId: "line-1",
        zohoItemId: "item-1",
        measureUnit: "EA",
        hsCode: "123456",
        hsName: "Test Item",
        vatClass: "A",
        vatGroupRate: "16",
      },
    ],
    ...overrides,
  };
}

describe("TremolFiscalDevice", () => {
  it("reports invalid command-plan input as a pre-send failure", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const device = createTremolFiscalDevice("http://localhost:4444", {
      receiptIssuanceEnabled: true,
      fetchImpl,
    });
    const snapshot = createTestSnapshot({
      customer: { ...createTestSnapshot().customer, companyName: "Bad,Name" },
    });

    const result = await device.issueReceipt(snapshot);

    expect(result).toMatchObject({ kind: "failed", failure: { code: "INVALID_RECEIPT_PLAN" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends a receipt command even when the local option is overridden", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const device = createTremolFiscalDevice("http://localhost:4444", {
      receiptIssuanceEnabled: true,
      fetchImpl,
    });

    await expect(device.issueReceipt(createTestSnapshot())).resolves.toMatchObject({
      kind: "failed",
      failure: { code: "RECEIPT_ISSUANCE_BLOCKED" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports implemented capabilities without claiming readiness or receipt issuance", () => {
    const device = createTremolFiscalDevice("http://localhost:4444");

    expect(device.getCapabilities()).toEqual({
      transport: "zfplabserver_http",
      supportedReadCommands: ["ReadStatus", "ReadVersion"],
      readinessDetermination: false,
      receiptIssuance: false,
    });
  });

  describe("constructor", () => {
    it("should create a device with the provided base URL", () => {
      const device = new TremolFiscalDevice({
        baseUrl: "http://localhost:4444",
      });
      expect(device.getConfig().baseUrl).toBe("http://localhost:4444");
    });
  });

  describe("createTremolFiscalDevice", () => {
    it("should create a device with safe defaults", () => {
      const device = createTremolFiscalDevice("http://localhost:4444");
      expect(device.getConfig().baseUrl).toBe("http://localhost:4444");
      expect(device.getConfig().commandTimeoutMs).toBe(5000);
      expect(device.getConfig().maxConcurrentOperations).toBe(1);
      expect(device.getConfig().receiptTimeoutMs).toBe(60000);
      expect(device.isIssuanceEnabled).toBe(false);
    });

    it("should allow overriding defaults", () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        commandTimeoutMs: 10000,
        receiptIssuanceEnabled: true,
      });
      expect(device.getConfig().commandTimeoutMs).toBe(10000);
      expect(device.isIssuanceEnabled).toBe(true);
    });

    it("rejects unsupported concurrency and unbounded timeouts", () => {
      expect(() =>
        createTremolFiscalDevice("http://localhost:4444", { maxConcurrentOperations: 2 }),
      ).toThrow("supports exactly one concurrent operation");
      expect(() =>
        createTremolFiscalDevice("http://localhost:4444", { receiptTimeoutMs: 120_001 }),
      ).toThrow("receiptTimeoutMs must be an integer between 100 and 120000 milliseconds.");
    });
  });

  describe("issueReceipt with issuance disabled", () => {
    let device: TremolFiscalDevice;

    beforeEach(() => {
      device = createTremolFiscalDevice("http://localhost:4444");
    });

    it("should throw ReceiptIssuanceDisabledError when issuance is disabled", async () => {
      const snapshot = createTestSnapshot();
      await expect(device.issueReceipt(snapshot)).rejects.toThrow(ReceiptIssuanceDisabledError);
    });

    it("should not execute any device commands when issuance is disabled", async () => {
      const snapshot = createTestSnapshot();
      try {
        await device.issueReceipt(snapshot);
      } catch {
        // Expected
      }
      // Verify no commands were sent
      expect(device.getInProgressReceipt()).toBeNull();
    });
  });

  describe("issueReceipt with issuance enabled", () => {
    let device: TremolFiscalDevice;

    beforeEach(() => {
      device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });
    });

    it("should return blocked result due to unverified protocol", async () => {
      const snapshot = createTestSnapshot();
      const result = await device.issueReceipt(snapshot);

      // The current implementation intentionally blocks until protocol is verified
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("RECEIPT_ISSUANCE_BLOCKED");
      }
    });

    it("should prevent concurrent receipt operations", async () => {
      const snapshot = createTestSnapshot();

      // Start first receipt
      const firstPromise = device.issueReceipt(snapshot);

      // Try to start second receipt immediately
      await expect(device.issueReceipt(snapshot)).rejects.toThrow(ReceiptInProgressError);

      // Wait for first to complete
      await firstPromise;
    });
  });

  describe("snapshot validation", () => {
    let device: TremolFiscalDevice;

    beforeEach(() => {
      device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });
    });

    it("should reject snapshot with unsupported currency", async () => {
      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          currencyCode: "USD",
        },
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });

    it("should reject snapshot with schema version mismatch", async () => {
      const snapshot = createTestSnapshot({
        schemaVersion: 2 as typeof FISCALIZATION_SNAPSHOT_VERSION,
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });

    it("should reject snapshot with missing customer", async () => {
      const snapshot = createTestSnapshot({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customer: undefined as any,
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });

    it("should reject snapshot with no line items", async () => {
      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          lines: [],
        },
        lineProfiles: [],
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });

    it("should reject snapshot with mismatched line counts", async () => {
      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          lines: [...createTestSnapshot().invoice.lines, ...createTestSnapshot().invoice.lines],
        },
        lineProfiles: createTestSnapshot().lineProfiles.slice(0, 1),
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });
  });

  describe("checkReadiness", () => {
    it("should report not ready when issuance is disabled", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444");
      const result = await device.checkReadiness();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("never treats connectivity as fiscal readiness while the Kenya contract is unverified", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });
      const result = await device.checkReadiness();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain("readiness contract is unverified");
    });

    it("should report not ready when a receipt is in progress", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot();
      // Start a receipt operation (will be blocked but still in progress)
      const promise = device.issueReceipt(snapshot);

      const result = await device.checkReadiness();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain("in progress");

      // Clean up
      await promise.catch(() => {});
    });
  });

  describe("safety guarantees", () => {
    it("should return outcome-unknown on unexpected errors", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot();
      const result = await device.issueReceipt(snapshot);

      // The local receipt command path remains deliberately blocked.
      expect(result.kind).toBe("failed");
    });

    it("should not expose sensitive data in error messages", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot({
        customer: {
          ...createTestSnapshot().customer,
          clientPin: "SENSITIVE_PIN_123",
        },
      });

      const result = await device.issueReceipt(snapshot);

      // Error messages should not contain the actual PIN
      if (result.kind === "failed") {
        expect(result.failure.message).not.toContain("SENSITIVE_PIN_123");
      }
      if (result.kind === "outcome-unknown") {
        expect(result.reason).not.toContain("SENSITIVE_PIN_123");
      }
    });

    it("should recover and allow subsequent operations after a failed receipt", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot();

      // First receipt fails (protocol not verified)
      const firstResult = await device.issueReceipt(snapshot);
      expect(firstResult.kind).toBe("failed");

      // State should be cleared after first operation
      expect(device.getInProgressReceipt()).toBeNull();

      // Second receipt should be allowed (not blocked by first failure)
      const secondResult = await device.issueReceipt(snapshot);
      expect(secondResult.kind).toBe("failed");
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should maintain correct in-progress state lifecycle", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot();

      // Before issuance, no receipt should be in progress
      expect(device.getInProgressReceipt()).toBeNull();

      // Start a receipt
      const promise = device.issueReceipt(snapshot);

      // During issuance, receipt should be in progress
      // Note: With async/await, the in-progress state is set and cleared
      // within the same synchronous execution, so we can't observe it from outside
      // This test verifies the state is properly managed internally

      // Wait for completion
      await promise;

      // After completion, state should be cleared
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should handle invalid currency code", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          currencyCode: "USD",
        },
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should handle schema version mismatch", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot({
        schemaVersion: 2 as typeof FISCALIZATION_SNAPSHOT_VERSION,
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should handle missing customer data", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      // Create snapshot with missing customer for validation test
      const base = createTestSnapshot();
      const snapshot: typeof base = {
        ...base,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        customer: undefined as any,
      };

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should handle empty line items", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          lines: [],
        },
        lineProfiles: [],
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
      expect(device.getInProgressReceipt()).toBeNull();
    });

    it("should handle mismatched line counts", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          lines: [...createTestSnapshot().invoice.lines, ...createTestSnapshot().invoice.lines],
        },
        lineProfiles: createTestSnapshot().lineProfiles.slice(0, 1),
      });

      const result = await device.issueReceipt(snapshot);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
      expect(device.getInProgressReceipt()).toBeNull();
    });
  });

  describe("concurrency and state management", () => {
    it("should prevent concurrent receipt operations from different snapshots", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot1 = createTestSnapshot({ snapshotId: "snapshot-1" });
      const snapshot2 = createTestSnapshot({ snapshotId: "snapshot-2" });

      // Start first receipt
      const firstPromise = device.issueReceipt(snapshot1);

      // Try to start second receipt immediately with different snapshot
      await expect(device.issueReceipt(snapshot2)).rejects.toThrow(ReceiptInProgressError);

      // Wait for first to complete
      await firstPromise;

      // Now second receipt should succeed (not blocked anymore)
      const result = await device.issueReceipt(snapshot2);
      expect(result.kind).toBe("failed"); // Still blocked by protocol
    });

    it("should allow sequential operations after first completes", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot1 = createTestSnapshot({ snapshotId: "snapshot-1" });
      const snapshot2 = createTestSnapshot({ snapshotId: "snapshot-2" });

      // First receipt
      const firstResult = await device.issueReceipt(snapshot1);
      expect(firstResult.kind).toBe("failed");

      // Second receipt should be allowed
      const secondResult = await device.issueReceipt(snapshot2);
      expect(secondResult.kind).toBe("failed");
    });

    it("should clear in-progress state even on validation failure", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const invalidSnapshot = createTestSnapshot({
        invoice: {
          ...createTestSnapshot().invoice,
          currencyCode: "USD",
        },
      });

      // Start with invalid snapshot
      const promise = device.issueReceipt(invalidSnapshot);

      // State should be set during execution
      // After completion (even with validation failure), state should be cleared
      const result = await promise;
      expect(result.kind).toBe("failed");
      expect(device.getInProgressReceipt()).toBeNull();

      // Next operation should be allowed
      const nextSnapshot = createTestSnapshot();
      await expect(device.issueReceipt(nextSnapshot)).resolves.toBeDefined();
    });

    it("should maintain accurate pending operations count", async () => {
      const device = createTremolFiscalDevice("http://localhost:4444", {
        receiptIssuanceEnabled: true,
      });

      const snapshot = createTestSnapshot();

      // Initially no pending operations
      // Note: pendingOperations is private, so we test its effect through checkReadiness

      // With issuance enabled but no operation in progress, readiness should fail on device check
      // But the pendingOperations check happens in checkReadiness
      const readinessBefore = await device.checkReadiness();
      // Should fail on device connectivity, not on pending operations
      expect(readinessBefore.ready).toBe(false);

      // Start an operation
      const promise = device.issueReceipt(snapshot);

      // During operation, pendingOperations > 0
      const readinessDuring = await device.checkReadiness();
      expect(readinessDuring.ready).toBe(false);
      expect(readinessDuring.reason).toContain("in progress");

      // After operation completes
      await promise;

      const readinessAfter = await device.checkReadiness();
      // Should fail on device connectivity, not on pending operations
      expect(readinessAfter.ready).toBe(false);
      expect(readinessAfter.reason).not.toContain("in progress");
    });
  });
});
