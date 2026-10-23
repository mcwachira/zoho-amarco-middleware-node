
import type {
    FiscalizationFailure,
    FiscalReceipt,
} from "../../domain/fiscalization/fiscalization-record.js";

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
 * Contract for communicating with the fiscal device.
 *
 * The application layer will depend on this interface rather than
 * depending directly on HTTP, ZFPLabServer, or a specific device SDK.
 *
 * We will add the validated invoice payload to this contract after
 * confirming the Zoho invoice fields and the relevant device commands.
 */
export interface FiscalDevice {
    /**
     * Executes one fiscal receipt operation.
     *
     * Implementations must serialize device commands and must not blindly
     * retry a command if its outcome could be uncertain.
     */
    issueReceipt(): Promise<FiscalDeviceResult>;
}
