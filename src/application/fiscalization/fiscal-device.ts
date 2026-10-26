import type {
  FiscalizationFailure,
  FiscalReceipt,
} from "../../domain/fiscalization/fiscalization-record.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";

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
 * The application passes a validated invoice candidate rather than
 * making the device adapter fetch invoice data itself.
 *
 * Implementations must use only verified device commands and must
 * never blindly retry an operation whose outcome is uncertain.
 */
export interface FiscalDevice {
    /**
     * Attempts to issue a fiscal receipt for the supplied invoice.
     *
     * The candidate contains mapped invoice data. It must not be treated
     * as proof that the invoice satisfies all Kenyan fiscal requirements.
     */
    issueReceipt(
        invoice: FiscalInvoiceCandidate,
    ): Promise<FiscalDeviceResult>;
}