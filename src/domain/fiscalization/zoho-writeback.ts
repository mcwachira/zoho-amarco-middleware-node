export const ZOHO_WRITEBACK_STATUSES = [
  "in_progress",
  "succeeded",
  "failed",
  "outcome_unknown",
] as const;

export type ZohoWritebackStatus = (typeof ZOHO_WRITEBACK_STATUSES)[number];

/** Contains correlation and progress metadata only; values stay in the fiscal record. */
export interface ZohoFiscalizationWritebackOperation {
  readonly id: string;
  readonly fiscalizationRequestId: string;
  readonly zohoInvoiceId: string;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly payloadHash: string;
  readonly status: ZohoWritebackStatus;
  readonly writtenCustomFieldIds: readonly string[];
  readonly errorCategory: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}
