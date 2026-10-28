import type { ZohoFiscalizationWritebackOperation } from "../../domain/fiscalization/zoho-writeback.js";

export interface CreateZohoWritebackOperationInput {
  readonly operation: ZohoFiscalizationWritebackOperation;
}

export interface ZohoFiscalizationWritebackRepository {
  findByFiscalizationRequestId(
    requestId: string,
  ): Promise<ZohoFiscalizationWritebackOperation | null>;
  create(operation: ZohoFiscalizationWritebackOperation): Promise<void>;
  recordWrittenCustomField(id: string, fieldId: string, updatedAt: Date): Promise<boolean>;
  transition(
    id: string,
    expectedStatus: ZohoFiscalizationWritebackOperation["status"],
    next: ZohoFiscalizationWritebackOperation,
  ): Promise<boolean>;
}
