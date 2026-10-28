import type {
  FiscalDevice,
  FiscalDeviceResult,
} from "../../application/fiscalization/fiscal-device.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";

/**
 * Simulated device outcome configuration.
 *
 * This allows tests to control exactly what the simulated device returns
 * without any real network calls or hardware dependencies.
 */
export interface TremolSimulatorOutcome {
  readonly kind:
    "success" | "failure" | "outcome-unknown" | "timeout" | "disconnected" | "busy" | "exception";
  readonly receiptNumber?: string;
  readonly issuedAt?: Date;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly unknownReason?: string;
}

/**
 * A deterministic simulator for the Tremol fiscal device.
 *
 * This simulator produces controlled outcomes for testing the fiscalization
 * workflow without any real device or network dependencies. All receipt
 * numbers and results are clearly labeled as simulated to prevent confusion
 * with genuine fiscal receipts.
 *
 * The simulator never sends commands to a real device.
 */
export class TremolSimulator {
  private outcomes: TremolSimulatorOutcome[] = [];
  private callCount = 0;
  private busy = false;
  private connected = true;
  private readinessDelay = 0;
  private receiptDelay = 0;

  /**
   * Configures the next outcome for issueReceipt.
   * Multiple outcomes can be queued and will be consumed in order.
   */
  setNextOutcome(outcome: TremolSimulatorOutcome): void {
    this.outcomes.push(outcome);
  }

  /**
   * Configures multiple outcomes in sequence.
   */
  setOutcomes(outcomes: TremolSimulatorOutcome[]): void {
    this.outcomes = [...outcomes];
  }

  /**
   * Clears all queued outcomes.
   */
  clearOutcomes(): void {
    this.outcomes = [];
  }

  /**
   * Sets whether the device is busy (concurrent request protection).
   */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /**
   * Sets whether the device is connected.
   */
  setConnected(connected: boolean): void {
    this.connected = connected;
  }

  /**
   * Sets an artificial delay for readiness check (simulates slow device).
   */
  setReadinessDelay(ms: number): void {
    this.readinessDelay = ms;
  }

  /**
   * Sets an artificial delay for receipt issuance (simulates slow receipt printing).
   */
  setReceiptDelay(ms: number): void {
    this.receiptDelay = ms;
  }

  /**
   * Gets the number of times issueReceipt has been called.
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Resets the simulator to initial state.
   */
  reset(): void {
    this.outcomes = [];
    this.callCount = 0;
    this.busy = false;
    this.connected = true;
    this.readinessDelay = 0;
    this.receiptDelay = 0;
  }

  /**
   * Internal method to get the next outcome or default.
   */
  private getNextOutcome(): TremolSimulatorOutcome {
    if (this.outcomes.length > 0) {
      return this.outcomes.shift()!;
    }
    // Default: return outcome-unknown to be safe
    return {
      kind: "outcome-unknown",
      unknownReason: "Simulator default: no outcome configured",
    };
  }

  /**
   * Simulates a readiness check.
   */
  async checkReadiness(): Promise<{ readonly ready: boolean; readonly reason?: string }> {
    if (this.readinessDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.readinessDelay));
    }

    if (!this.connected) {
      return { ready: false, reason: "Simulated device is disconnected" };
    }

    if (this.busy) {
      return { ready: false, reason: "Simulated device is busy" };
    }

    return { ready: true };
  }

  /**
   * Simulates issuing a fiscal receipt.
   */
  async issueReceipt(snapshot: FiscalizationSnapshot): Promise<FiscalDeviceResult> {
    // Minimal validation - snapshot is required for interface conformance
    if (!snapshot?.invoice?.zohoInvoiceId) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_SNAPSHOT",
          message: "Snapshot missing invoice ID",
        },
      };
    }
    this.callCount++;

    if (this.receiptDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.receiptDelay));
    }

    if (!this.connected) {
      return {
        kind: "outcome-unknown",
        reason: "Simulated device is disconnected",
      };
    }

    if (this.busy) {
      return {
        kind: "failed",
        failure: {
          code: "DEVICE_BUSY",
          message: "Simulated device is busy with another operation",
        },
      };
    }

    const outcome = this.getNextOutcome();

    switch (outcome.kind) {
      case "success": {
        const configuredReceiptNumber = outcome.receiptNumber?.trim();
        const receiptNumber = configuredReceiptNumber
          ? configuredReceiptNumber.startsWith("SIM-")
            ? configuredReceiptNumber
            : `SIM-${configuredReceiptNumber}`
          : `SIM-${Date.now()}-${this.callCount}`;
        const issuedAt = outcome.issuedAt ?? new Date();
        return {
          kind: "succeeded",
          receipt: {
            receiptNumber,
            issuedAt,
          },
        };
      }

      case "failure": {
        return {
          kind: "failed",
          failure: {
            code: outcome.failureCode ?? "SIMULATED_FAILURE",
            message: outcome.failureMessage ?? "Simulated device failure",
          },
        };
      }

      case "outcome-unknown": {
        return {
          kind: "outcome-unknown",
          reason: outcome.unknownReason ?? "Simulated uncertain outcome",
        };
      }

      case "timeout": {
        return {
          kind: "outcome-unknown",
          reason: "Simulated receipt issuance timed out",
        };
      }

      case "disconnected": {
        return {
          kind: "outcome-unknown",
          reason: "Simulated device disconnected during operation",
        };
      }

      case "busy": {
        return {
          kind: "failed",
          failure: {
            code: "DEVICE_BUSY",
            message: "Simulated device is busy with another operation",
          },
        };
      }

      case "exception": {
        throw new Error("Simulated device adapter exception.");
      }

      default: {
        return {
          kind: "outcome-unknown",
          reason: "Simulator: unknown outcome kind",
        };
      }
    }
  }
}

/**
 * A FiscalDevice implementation that uses a TremolSimulator for deterministic testing.
 *
 * This device is clearly labeled as simulated and should never be used
 * in production. It provides the same interface as the real TremolFiscalDevice
 * but with fully controllable outcomes.
 */
export class SimulatedTremolFiscalDevice implements FiscalDevice {
  readonly executionMode = "simulated" as const;
  private readonly simulator: TremolSimulator;
  private readonly deviceId: string;

  constructor(simulator: TremolSimulator, deviceId = "simulated-tremol-1") {
    this.simulator = simulator;
    this.deviceId = deviceId;
  }

  getSimulator(): TremolSimulator {
    return this.simulator;
  }

  getDeviceId(): string {
    return this.deviceId;
  }

  async issueReceipt(snapshot: FiscalizationSnapshot): Promise<FiscalDeviceResult> {
    // Validate snapshot has required fields for simulation
    if (!snapshot.invoice?.zohoInvoiceId) {
      return {
        kind: "failed",
        failure: {
          code: "INVALID_SNAPSHOT",
          message: "Snapshot missing invoice ID",
        },
      };
    }

    return this.simulator.issueReceipt(snapshot);
  }

  /**
   * Checks device readiness using the simulator.
   */
  async checkReadiness(): Promise<{ readonly ready: boolean; readonly reason?: string }> {
    return this.simulator.checkReadiness();
  }
}

/**
 * Creates a simulated Tremol fiscal device with safe defaults.
 *
 * This is a factory for testing purposes only. The simulated device
 * never contacts real hardware.
 */
export function createSimulatedTremolFiscalDevice(
  simulator?: TremolSimulator,
  deviceId?: string,
): SimulatedTremolFiscalDevice {
  const sim = simulator ?? new TremolSimulator();
  return new SimulatedTremolFiscalDevice(sim, deviceId);
}

/**
 * Creates a simulator pre-configured with a sequence of outcomes.
 */
export function createTremolSimulatorWithOutcomes(
  outcomes: TremolSimulatorOutcome[],
): TremolSimulator {
  const simulator = new TremolSimulator();
  simulator.setOutcomes(outcomes);
  return simulator;
}

/**
 * Creates a simulator for a successful simulated receipt issuance.
 */
export function createSuccessfulSimulator(
  receiptNumber?: string,
  issuedAt?: Date,
): TremolSimulator {
  const simulator = new TremolSimulator();
  const outcome: TremolSimulatorOutcome = {
    kind: "success",
    ...(receiptNumber !== undefined ? { receiptNumber } : {}),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
  simulator.setNextOutcome(outcome);
  return simulator;
}

/**
 * Creates a simulator for a failed simulated receipt issuance.
 */
export function createFailedSimulator(
  failureCode?: string,
  failureMessage?: string,
): TremolSimulator {
  const simulator = new TremolSimulator();
  const outcome: TremolSimulatorOutcome = {
    kind: "failure",
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(failureMessage !== undefined ? { failureMessage } : {}),
  };
  simulator.setNextOutcome(outcome);
  return simulator;
}

/**
 * Creates a simulator for an uncertain outcome requiring reconciliation.
 */
export function createUncertainOutcomeSimulator(unknownReason?: string): TremolSimulator {
  const simulator = new TremolSimulator();
  const outcome: TremolSimulatorOutcome = {
    kind: "outcome-unknown",
    ...(unknownReason !== undefined ? { unknownReason } : {}),
  };
  simulator.setNextOutcome(outcome);
  return simulator;
}

/**
 * Creates a simulator for a timeout outcome.
 */
export function createTimeoutSimulator(): TremolSimulator {
  const simulator = new TremolSimulator();
  simulator.setNextOutcome({ kind: "timeout" });
  return simulator;
}

/**
 * Creates a simulator for a disconnected device.
 */
export function createDisconnectedSimulator(): TremolSimulator {
  const simulator = new TremolSimulator();
  simulator.setConnected(false);
  simulator.setNextOutcome({ kind: "disconnected" });
  return simulator;
}

/**
 * Creates a simulator for a busy device.
 */
export function createBusySimulator(): TremolSimulator {
  const simulator = new TremolSimulator();
  simulator.setBusy(true);
  simulator.setNextOutcome({ kind: "busy" });
  return simulator;
}
