/**
 * Unit tests for the TremolSimulator.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  TremolSimulator,
  SimulatedTremolFiscalDevice,
  createTremolSimulatorWithOutcomes,
  createSuccessfulSimulator,
  createFailedSimulator,
  createUncertainOutcomeSimulator,
  createTimeoutSimulator,
  createDisconnectedSimulator,
  createBusySimulator,
  createSimulatedTremolFiscalDevice,
} from "../../src/infrastructure/device/tremol-simulator.js";
import type { FiscalizationSnapshot } from "../../src/domain/fiscalization/fiscalization-snapshot.js";

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
    payments: [],
    ...overrides,
  };
}

describe("TremolSimulator", () => {
  let simulator: TremolSimulator;
  let device: SimulatedTremolFiscalDevice;
  let snapshot: FiscalizationSnapshot;

  beforeEach(() => {
    simulator = new TremolSimulator();
    device = new SimulatedTremolFiscalDevice(simulator);
    snapshot = createTestSnapshot();
  });

  describe("constructor and basic state", () => {
    it("should create a simulator with default state", () => {
      expect(simulator.getCallCount()).toBe(0);
    });

    it("should create a device with the simulator", () => {
      expect(device.getSimulator()).toBe(simulator);
      expect(device.getDeviceId()).toBe("simulated-tremol-1");
    });

    it("should reset to initial state", async () => {
      simulator.setNextOutcome({ kind: "success" });
      simulator.setBusy(true);
      simulator.setConnected(false);

      simulator.reset();

      expect(simulator.getCallCount()).toBe(0);
      const readiness = await device.checkReadiness();
      expect(readiness.ready).toBe(true);
    });
  });

  describe("successful outcome", () => {
    it("should return succeeded with receipt details", async () => {
      simulator.setNextOutcome({
        kind: "success",
        receiptNumber: "SIM-000123",
        issuedAt: new Date("2026-10-27T10:00:00.000Z"),
      });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("succeeded");
      if (result.kind === "succeeded") {
        expect(result.receipt.receiptNumber).toBe("SIM-000123");
        expect(result.receipt.issuedAt).toEqual(new Date("2026-10-27T10:00:00.000Z"));
      }
    });

    it("should generate default receipt number and timestamp if not provided", async () => {
      simulator.setNextOutcome({ kind: "success" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("succeeded");
      if (result.kind === "succeeded") {
        expect(result.receipt.receiptNumber).toMatch(/^SIM-\d+-\d+$/);
        expect(result.receipt.issuedAt).toBeInstanceOf(Date);
      }
    });

    it("should increment call count", async () => {
      simulator.setNextOutcome({ kind: "success" });
      simulator.setNextOutcome({ kind: "success" });

      await device.issueReceipt(snapshot);
      await device.issueReceipt(snapshot);

      expect(simulator.getCallCount()).toBe(2);
    });
  });

  describe("failed outcome", () => {
    it("should return failed with failure details", async () => {
      simulator.setNextOutcome({
        kind: "failure",
        failureCode: "DEVICE_ERROR",
        failureMessage: "Simulated device error",
      });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("DEVICE_ERROR");
        expect(result.failure.message).toBe("Simulated device error");
      }
    });

    it("should use default failure code and message if not provided", async () => {
      simulator.setNextOutcome({ kind: "failure" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("SIMULATED_FAILURE");
        expect(result.failure.message).toBe("Simulated device failure");
      }
    });
  });

  describe("outcome-unknown outcome", () => {
    it("should return outcome-unknown with reason", async () => {
      simulator.setNextOutcome({
        kind: "outcome-unknown",
        unknownReason: "Simulated timeout during execution",
      });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("outcome-unknown");
      if (result.kind === "outcome-unknown") {
        expect(result.reason).toBe("Simulated timeout during execution");
      }
    });

    it("should use default reason if not provided", async () => {
      simulator.setNextOutcome({ kind: "outcome-unknown" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("outcome-unknown");
      if (result.kind === "outcome-unknown") {
        expect(result.reason).toBe("Simulated uncertain outcome");
      }
    });
  });

  describe("timeout outcome", () => {
    it("should return outcome-unknown with timeout reason", async () => {
      simulator.setNextOutcome({ kind: "timeout" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("outcome-unknown");
      if (result.kind === "outcome-unknown") {
        expect(result.reason).toBe("Simulated receipt issuance timed out");
      }
    });
  });

  describe("disconnected device", () => {
    it("should return outcome-unknown when device is disconnected", async () => {
      simulator.setConnected(false);
      simulator.setNextOutcome({ kind: "disconnected" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("outcome-unknown");
      if (result.kind === "outcome-unknown") {
        expect(result.reason).toBe("Simulated device is disconnected");
      }
    });

    it("should report not ready when disconnected", async () => {
      simulator.setConnected(false);

      const readiness = await device.checkReadiness();

      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toContain("disconnected");
    });
  });

  describe("busy device", () => {
    it("should return failed with DEVICE_BUSY when busy", async () => {
      simulator.setBusy(true);
      simulator.setNextOutcome({ kind: "busy" });

      const result = await device.issueReceipt(snapshot);

      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("DEVICE_BUSY");
      }
    });

    it("should report not ready when busy", async () => {
      simulator.setBusy(true);

      const readiness = await device.checkReadiness();

      expect(readiness.ready).toBe(false);
      expect(readiness.reason).toContain("busy");
    });
  });

  describe("receipt delay", () => {
    it("should simulate receipt issuance delay", async () => {
      simulator.setReceiptDelay(50);
      simulator.setNextOutcome({ kind: "success" });

      const start = Date.now();
      await device.issueReceipt(snapshot);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe("readiness delay", () => {
    it("should simulate readiness check delay", async () => {
      simulator.setReadinessDelay(50);

      const start = Date.now();
      await device.checkReadiness();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe("invalid snapshot", () => {
    it("should return failed for missing invoice ID", async () => {
      const invalidSnapshot = createTestSnapshot({
        invoice: { ...createTestSnapshot().invoice, zohoInvoiceId: "" },
      });

      const result = await device.issueReceipt(invalidSnapshot);

      expect(result.kind).toBe("failed");
      if (result.kind === "failed") {
        expect(result.failure.code).toBe("INVALID_SNAPSHOT");
      }
    });
  });

  describe("multiple outcomes in sequence", () => {
    it("should consume outcomes in order", async () => {
      simulator.setOutcomes([
        { kind: "success", receiptNumber: "SIM-1" },
        { kind: "failure", failureCode: "ERROR_1" },
        { kind: "outcome-unknown", unknownReason: "Unknown" },
      ]);

      const result1 = await device.issueReceipt(snapshot);
      const result2 = await device.issueReceipt(snapshot);
      const result3 = await device.issueReceipt(snapshot);

      expect(result1.kind).toBe("succeeded");
      expect(result2.kind).toBe("failed");
      expect(result3.kind).toBe("outcome-unknown");
    });

    it("should fall back to default outcome when queue is empty", async () => {
      simulator.setNextOutcome({ kind: "success" });

      await device.issueReceipt(snapshot); // consumes the success outcome
      const result = await device.issueReceipt(snapshot); // no outcomes left

      expect(result.kind).toBe("outcome-unknown");
    });
  });
});

describe("Factory functions", () => {
  let snapshot: FiscalizationSnapshot;

  beforeEach(() => {
    snapshot = createTestSnapshot();
  });

  it("createSuccessfulSimulator should create a simulator with success outcome", async () => {
    const simulator = createSuccessfulSimulator("CUSTOM-123", new Date("2026-10-27T12:00:00.000Z"));
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result = await device.issueReceipt(snapshot);

    expect(result.kind).toBe("succeeded");
    if (result.kind === "succeeded") {
      expect(result.receipt.receiptNumber).toBe("SIM-CUSTOM-123");
      expect(result.receipt.issuedAt).toEqual(new Date("2026-10-27T12:00:00.000Z"));
    }
  });

  it("always labels configured simulator receipts with the SIM prefix", async () => {
    const simulator = createSuccessfulSimulator("REAL-LOOKING-123");
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result = await device.issueReceipt(snapshot);

    expect(result).toMatchObject({
      kind: "succeeded",
      receipt: { receiptNumber: "SIM-REAL-LOOKING-123" },
    });
  });

  it("createFailedSimulator should create a simulator with failure outcome", async () => {
    const simulator = createFailedSimulator("CUSTOM_ERROR", "Custom error message");
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result = await device.issueReceipt(snapshot);

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failure.code).toBe("CUSTOM_ERROR");
      expect(result.failure.message).toBe("Custom error message");
    }
  });

  it("createUncertainOutcomeSimulator should create a simulator with uncertain outcome", async () => {
    const simulator = createUncertainOutcomeSimulator("Custom unknown reason");
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result = await device.issueReceipt(snapshot);

    expect(result.kind).toBe("outcome-unknown");
    if (result.kind === "outcome-unknown") {
      expect(result.reason).toBe("Custom unknown reason");
    }
  });

  it("createTimeoutSimulator should create a simulator with timeout outcome", async () => {
    const simulator = createTimeoutSimulator();
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result = await device.issueReceipt(snapshot);

    expect(result.kind).toBe("outcome-unknown");
    if (result.kind === "outcome-unknown") {
      expect(result.reason).toBe("Simulated receipt issuance timed out");
    }
  });

  it("createDisconnectedSimulator should create a simulator with disconnected device", async () => {
    const simulator = createDisconnectedSimulator();
    const device = new SimulatedTremolFiscalDevice(simulator);

    const readiness = await device.checkReadiness();
    expect(readiness.ready).toBe(false);

    const result = await device.issueReceipt(snapshot);
    expect(result.kind).toBe("outcome-unknown");
  });

  it("createBusySimulator should create a simulator with busy device", async () => {
    const simulator = createBusySimulator();
    const device = new SimulatedTremolFiscalDevice(simulator);

    const readiness = await device.checkReadiness();
    expect(readiness.ready).toBe(false);

    const result = await device.issueReceipt(snapshot);
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.failure.code).toBe("DEVICE_BUSY");
    }
  });

  it("createTremolSimulatorWithOutcomes should create a simulator with multiple outcomes", async () => {
    const simulator = createTremolSimulatorWithOutcomes([{ kind: "success" }, { kind: "failure" }]);
    const device = new SimulatedTremolFiscalDevice(simulator);

    const result1 = await device.issueReceipt(snapshot);
    const result2 = await device.issueReceipt(snapshot);

    expect(result1.kind).toBe("succeeded");
    expect(result2.kind).toBe("failed");
  });
});

describe("createSimulatedTremolFiscalDevice", () => {
  let snapshot: FiscalizationSnapshot;

  beforeEach(() => {
    snapshot = createTestSnapshot();
  });

  it("should create a device with default simulator", async () => {
    const device = createSimulatedTremolFiscalDevice();
    const result = await device.issueReceipt(snapshot);

    // Default is outcome-unknown
    expect(result.kind).toBe("outcome-unknown");
  });

  it("should create a device with custom simulator", async () => {
    const simulator = createSuccessfulSimulator();
    const device = createSimulatedTremolFiscalDevice(simulator);
    const result = await device.issueReceipt(snapshot);

    expect(result.kind).toBe("succeeded");
  });

  it("should create a device with custom device ID", async () => {
    const simulator = new TremolSimulator();
    const device = createSimulatedTremolFiscalDevice(simulator, "custom-device-1");

    expect(device.getDeviceId()).toBe("custom-device-1");
  });
});
