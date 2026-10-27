import { randomUUID } from "node:crypto";

import type { RegisterFiscalizationRequestService } from "./register-fiscalization-request.js";
import type { FiscalizationRecord } from "../../domain/fiscalization/fiscalization-record.js";
import type { ZohoInvoiceService } from "../zoho/zoho-invoice-service.js";
import type { InvoiceMappingResult } from "../zoho/zoho-invoice-mapper.js";
import type { FiscalCustomerProfileRepository } from "./fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "./fiscal-item-profile-repository.js";
import {
  buildFiscalizationSnapshot,
  type FiscalizationSnapshotBuildResult,
} from "./fiscalization-snapshot.js";

/**
 * Result of preparing a fiscalization request.
 *
 * A registered request is still Pending. It has not been sent to
 * the fiscal device and does not mean a fiscal receipt exists.
 */
export type PrepareFiscalizationRequestResult =
  | {
      readonly kind: "mapping-failed";
      readonly errors: Extract<InvoiceMappingResult, { success: false }>["errors"];
    }
  | {
      readonly kind: "snapshot-failed";
      readonly errors: Extract<FiscalizationSnapshotBuildResult, { success: false }>["errors"];
    }
  | {
      readonly kind: "registered";
      readonly record: FiscalizationRecord;
    };

export class PrepareFiscalizationRequestService {
  constructor(
    private readonly invoiceService: Pick<ZohoInvoiceService, "getFiscalInvoiceCandidate">,
    private readonly registrationService: Pick<
      RegisterFiscalizationRequestService,
      "findExisting" | "register"
    >,
    private readonly dependencies: {
      readonly zohoOrganizationId: string;
      readonly customerProfiles: Pick<FiscalCustomerProfileRepository, "findByZohoCustomerId">;
      readonly itemProfiles: Pick<FiscalItemProfileRepository, "findByZohoItemId">;
      readonly generateId?: () => string;
      readonly now?: () => Date;
    },
  ) {}

  findExisting(invoiceId: string): Promise<FiscalizationRecord | null> {
    return this.registrationService.findExisting(invoiceId);
  }

  async prepare(invoiceId: string): Promise<PrepareFiscalizationRequestResult> {
    const requestedInvoiceId = invoiceId.trim();
    if (!requestedInvoiceId) {
      return {
        kind: "mapping-failed",
        errors: [{ field: "invoiceId", message: "A valid Zoho invoice ID is required." }],
      };
    }

    const mapping = await this.invoiceService.getFiscalInvoiceCandidate(requestedInvoiceId);

    if (!mapping.success) {
      return {
        kind: "mapping-failed",
        errors: mapping.errors,
      };
    }

    if (mapping.candidate.zohoInvoiceId !== requestedInvoiceId) {
      return {
        kind: "mapping-failed",
        errors: [
          {
            field: "invoiceId",
            message: "The retrieved invoice identity does not match the requested invoice.",
          },
        ],
      };
    }

    const registeredAt = this.dependencies.now?.() ?? new Date();
    const snapshotResult = await buildFiscalizationSnapshot({
      invoice: mapping.candidate,
      zohoOrganizationId: this.dependencies.zohoOrganizationId,
      customerProfiles: this.dependencies.customerProfiles,
      itemProfiles: this.dependencies.itemProfiles,
      registeredAt,
    });

    if (!snapshotResult.success) {
      return {
        kind: "snapshot-failed",
        errors: snapshotResult.errors,
      };
    }

    const record = await this.registrationService.register({
      id: (this.dependencies.generateId ?? randomUUID)(),
      invoice: mapping.candidate,
      snapshot: snapshotResult.snapshot,
    });

    return {
      kind: "registered",
      record,
    };
  }
}
