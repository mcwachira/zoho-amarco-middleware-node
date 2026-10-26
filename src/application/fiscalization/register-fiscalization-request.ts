
import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";
import {
    createFiscalizationRecord,
    type FiscalizationRecord,
} from "../../domain/fiscalization/fiscalization-record.js";

/**
 * Input needed to register a fiscalization request.
 *
 * Registration does not claim the request or communicate with a device.
 */
export interface RegisterFiscalizationRequestInput {
    readonly id: string;
    readonly invoice: FiscalInvoiceCandidate;
}

/**
 * Registers a mapped Zoho invoice for later fiscalization.
 *
 * This service deliberately does not depend on FiscalDevice. That makes
 * it impossible for this workflow to issue a physical fiscal receipt.
 */
export class RegisterFiscalizationRequestService {
    constructor(
        private readonly repository: FiscalizationRepository,
    ) {}

    async register(
        input: RegisterFiscalizationRequestInput,
    ): Promise<FiscalizationRecord> {
        const record = createFiscalizationRecord({
            id: input.id,
            zohoInvoiceId: input.invoice.zohoInvoiceId,
        });

        await this.repository.create(record);

        // Return the Pending record only after persistence succeeds.
        // No claim and no device operation occur in this service.
        return record;
    }
}
