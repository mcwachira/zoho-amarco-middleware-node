import type {
  FiscalDeviceConnectionResult,
  FiscalDeviceDiagnostics,
} from "../../application/fiscalization/fiscal-device-diagnostics.js";
import type { TremolZfpLabServerClient } from "./tremol-zfplabserver-client.js";
/**
 * Implements application-level diagnostics using the existing
 * read-only ZFPLabServer HTTP client.
 */
export class TremolDeviceDiagnostics implements FiscalDeviceDiagnostics {
  constructor(private readonly client: TremolZfpLabServerClient) {}

  async checkConnection(): Promise<FiscalDeviceConnectionResult> {
    try {
      // The version field is validated, but is not compared with an
      // established firmware compatibility matrix or readiness rule.
      await this.client.readVersion();

      return { status: "connected" };
    } catch (error: unknown) {
      // Avoid exposing raw response bodies or internal URLs to API callers.
      // Detailed diagnostics can be logged by the API layer if needed.
      const reason = error instanceof Error ? error.name : "UnknownDeviceConnectionError";

      return {
        status: "unavailable",
        reason,
      };
    }
  }
}
