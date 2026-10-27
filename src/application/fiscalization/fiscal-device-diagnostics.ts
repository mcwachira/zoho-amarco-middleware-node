/**
 * Read-only diagnostics for the fiscal device integration.
 *
 * This contract reports whether the device service can be contacted.
 * It does not certify that the fiscal unit is ready to issue receipts.
 */
export interface FiscalDeviceDiagnostics {
  /**
   * Checks whether the configured device service responds to a
   * supported read-only command.
   *
   * Implementations must not issue receipts or change device state.
   */
  checkConnection(): Promise<FiscalDeviceConnectionResult>;
}

export type FiscalDeviceConnectionResult =
  | {
      readonly status: "connected";
    }
  | {
      readonly status: "unavailable";
      readonly reason: string;
    };
