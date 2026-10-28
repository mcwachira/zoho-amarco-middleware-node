import type { FiscalizationRepository } from "./fiscalization-repository.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";
import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";
import {
  createFiscalizationRecord,
  type FiscalizationRecord,
} from "../../domain/fiscalization/fiscalization-record.js";
import { parseFiscalizationSnapshot } from "./fiscalization-snapshot.js";
import {
  DuplicateZohoInvoiceError,
  FiscalizationRequestPersistenceError,
} from "./fiscalization-errors.js";

/**
 * Input needed to register a fiscalization request.
 *
 * Registration does not claim the request or communicate with a device.
 */
export interface RegisterFiscalizationRequestInput {
  readonly id: string;
  readonly invoice: FiscalInvoiceCandidate;
  readonly snapshot: FiscalizationSnapshot;
}

/**
 * Registers a mapped Zoho invoice for later fiscalization.
 *
 * This service deliberately does not depend on FiscalDevice. That makes
 * it impossible for this workflow to issue a physical fiscal receipt.
 */
export class RegisterFiscalizationRequestService {
  constructor(private readonly repository: FiscalizationRepository) {}

  findExisting(zohoInvoiceId: string): Promise<FiscalizationRecord | null> {
    return this.repository.findByZohoInvoiceId(zohoInvoiceId);
  }

  async register(input: RegisterFiscalizationRequestInput): Promise<FiscalizationRecord> {
    const snapshot = parseFiscalizationSnapshot(input.snapshot, input.snapshot.schemaVersion);
    if (JSON.stringify(snapshot.invoice) !== JSON.stringify(input.invoice)) {
      throw new Error("Fiscalization snapshot does not match the invoice registration input.");
    }

    const record = createFiscalizationRecord(
      {
        id: input.id,
        zohoInvoiceId: input.invoice.zohoInvoiceId,
        snapshot,
      },
      new Date(snapshot.registeredAt),
    );

    try {
      await this.repository.create(record);
    } catch (error: unknown) {
      if (error instanceof DuplicateZohoInvoiceError) throw error;
      throw new FiscalizationRequestPersistenceError();
    }

    // Return the Pending record only after persistence succeeds.
    // No claim and no device operation occur in this service.
    return record;
  }
}
