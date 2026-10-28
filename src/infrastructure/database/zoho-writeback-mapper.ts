import {
  ZOHO_WRITEBACK_STATUSES,
  type ZohoFiscalizationWritebackOperation,
} from "../../domain/fiscalization/zoho-writeback.js";

export interface ZohoWritebackOperationRow {
  id: string;
  fiscalizationRequestId: string;
  zohoInvoiceId: string;
  organizationId: string;
  correlationId: string;
  payloadHash: string;
  status: string;
  writtenCustomFieldIdsJson: string;
  errorCategory: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export function toDomainZohoWriteback(
  row: ZohoWritebackOperationRow,
): ZohoFiscalizationWritebackOperation {
  if (!ZOHO_WRITEBACK_STATUSES.includes(row.status as (typeof ZOHO_WRITEBACK_STATUSES)[number])) {
    throw new Error("Stored Zoho writeback operation has an invalid state.");
  }
  let writtenCustomFieldIds: unknown;
  try {
    writtenCustomFieldIds = JSON.parse(row.writtenCustomFieldIdsJson) as unknown;
  } catch {
    throw new Error("Stored Zoho writeback progress is malformed.");
  }
  if (
    !Array.isArray(writtenCustomFieldIds) ||
    !writtenCustomFieldIds.every(
      (value) => typeof value === "string" && /^\d{1,40}$/.test(value),
    ) ||
    new Set(writtenCustomFieldIds).size !== writtenCustomFieldIds.length
  ) {
    throw new Error("Stored Zoho writeback progress is invalid.");
  }
  if (!/^[a-f0-9]{64}$/i.test(row.payloadHash)) {
    throw new Error("Stored Zoho writeback payload digest is invalid.");
  }
  return {
    ...row,
    status: row.status as ZohoFiscalizationWritebackOperation["status"],
    writtenCustomFieldIds,
  };
}

export function toDatabaseZohoWriteback(
  operation: ZohoFiscalizationWritebackOperation,
): ZohoWritebackOperationRow {
  const { writtenCustomFieldIds, ...columns } = operation;
  return {
    ...columns,
    writtenCustomFieldIdsJson: JSON.stringify(writtenCustomFieldIds),
  };
}
