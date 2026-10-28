import type {
  FiscalizationFailure,
  FiscalReceipt,
} from "../../domain/fiscalization/fiscalization-record.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";

/**
 * The outcome reported by the fiscal-device adapter.
 *
 * These three cases are deliberately separate:
 *
 * - succeeded: the device confirmed that the receipt was issued.
 * - failed: we have evidence that the operation failed.
 * - outcome-unknown: the receipt might have been issued, but we cannot
 *   establish the final result.
 *
 * A timeout must not automatically be reported as "failed".
 */
export type FiscalDeviceResult =
  | {
      readonly kind: "succeeded";
      readonly receipt: FiscalReceipt;
    }
  | {
      readonly kind: "failed";
      readonly failure: FiscalizationFailure;
    }
  | {
      readonly kind: "outcome-unknown";
      readonly reason: string;
    };

/**
 * Contract for communicating with a fiscal device.
 *
 * The application passes the immutable validated snapshot rather than
 * making the adapter fetch invoice or profile data itself.
 *
 * Implementations must use only verified device commands and must
 * never blindly retry an operation whose outcome is uncertain.
 */
export interface FiscalDevice {
  /** Explicit execution source; omitted implementations are unverified. */
  readonly executionMode?: "simulated" | "real";
  /** Optional preflight check; it must not begin receipt issuance. */
  checkReadiness?(): Promise<{ readonly ready: boolean; readonly reason?: string }>;
  /**
   * Attempts to issue a fiscal receipt for the supplied invoice.
   *
   * The candidate contains mapped invoice data. It must not be treated
   * as proof that the invoice satisfies all Kenyan fiscal requirements.
   */
  issueReceipt(snapshot: FiscalizationSnapshot): Promise<FiscalDeviceResult>;
}
