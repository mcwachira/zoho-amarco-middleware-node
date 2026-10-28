import type { ZohoFiscalizationWritebackRepository } from "../../application/zoho/zoho-fiscalization-writeback-repository.js";
import type { ZohoFiscalizationWritebackOperation } from "../../domain/fiscalization/zoho-writeback.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import { toDatabaseZohoWriteback, toDomainZohoWriteback } from "./zoho-writeback-mapper.js";

export class PostgresqlZohoFiscalizationWritebackRepository implements ZohoFiscalizationWritebackRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByFiscalizationRequestId(requestId: string) {
    const row = await this.prisma.zohoFiscalizationWritebackOperation.findUnique({
      where: { fiscalizationRequestId: requestId },
    });
    return row ? toDomainZohoWriteback(row) : null;
  }

  async create(operation: ZohoFiscalizationWritebackOperation): Promise<void> {
    await this.prisma.zohoFiscalizationWritebackOperation.create({
      data: toDatabaseZohoWriteback(operation),
    });
  }

  async recordWrittenCustomField(id: string, fieldId: string, updatedAt: Date): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const row = await transaction.zohoFiscalizationWritebackOperation.findUnique({
        where: { id },
      });
      if (!row || row.status !== "in_progress") return false;
      const current = toDomainZohoWriteback(row);
      const writtenCustomFieldIds = current.writtenCustomFieldIds.includes(fieldId)
        ? current.writtenCustomFieldIds
        : [...current.writtenCustomFieldIds, fieldId];
      const result = await transaction.zohoFiscalizationWritebackOperation.updateMany({
        where: {
          id,
          status: "in_progress",
          writtenCustomFieldIdsJson: row.writtenCustomFieldIdsJson,
        },
        data: { writtenCustomFieldIdsJson: JSON.stringify(writtenCustomFieldIds), updatedAt },
      });
      return result.count === 1;
    });
  }

  async transition(
    id: string,
    expectedStatus: ZohoFiscalizationWritebackOperation["status"],
    next: ZohoFiscalizationWritebackOperation,
  ): Promise<boolean> {
    const result = await this.prisma.zohoFiscalizationWritebackOperation.updateMany({
      where: { id, status: expectedStatus },
      data: toDatabaseZohoWriteback(next),
    });
    return result.count === 1;
  }
}
