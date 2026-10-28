import type {
  FiscalItemProfile,
  FiscalItemProfileData,
  FiscalItemProfileRepository,
  NewFiscalItemProfile,
} from "../../application/fiscalization/fiscal-item-profile-repository.js";
import {
  DuplicateFiscalProfileError,
  FiscalProfileNotFoundError,
} from "../../application/fiscalization/fiscal-profile-errors.js";
import {
  normalizeItemIdentity,
  normalizeItemProfileData,
  normalizeNewItemProfile,
} from "../../application/fiscalization/fiscal-profile-validation.js";
import type { FiscalItemProfile as PrismaFiscalItemProfile } from "../../generated/prisma/postgresql/client.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import {
  isPrismaRecordNotFound,
  isProfileIdentityConflict,
} from "./fiscal-profile-prisma-errors.js";

function toDomainProfile(row: PrismaFiscalItemProfile): FiscalItemProfile {
  return {
    id: row.id,
    zohoItemId: row.zohoItemId,
    measureUnit: row.measureUnit,
    hsCode: row.hsCode,
    hsName: row.hsName,
    vatClass: row.vatClass,
    vatGroupRate: row.vatGroupRate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresqlFiscalItemProfileRepository implements FiscalItemProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByZohoItemId(zohoItemId: string): Promise<FiscalItemProfile | null> {
    const identity = normalizeItemIdentity(zohoItemId);
    const row = await this.prisma.fiscalItemProfile.findUnique({
      where: { zohoItemId: identity },
    });

    return row === null ? null : toDomainProfile(row);
  }

  async create(profile: NewFiscalItemProfile): Promise<FiscalItemProfile> {
    const normalized = normalizeNewItemProfile(profile);

    try {
      const row = await this.prisma.fiscalItemProfile.create({ data: normalized });
      return toDomainProfile(row);
    } catch (error: unknown) {
      if (isProfileIdentityConflict(error, "zohoItemId")) {
        throw new DuplicateFiscalProfileError("item");
      }

      throw error;
    }
  }

  async update(zohoItemId: string, profile: FiscalItemProfileData): Promise<FiscalItemProfile> {
    const identity = normalizeItemIdentity(zohoItemId);
    const normalized = normalizeItemProfileData(profile);

    try {
      const row = await this.prisma.fiscalItemProfile.update({
        where: { zohoItemId: identity },
        data: normalized,
      });

      return toDomainProfile(row);
    } catch (error: unknown) {
      if (isPrismaRecordNotFound(error)) {
        throw new FiscalProfileNotFoundError("item");
      }

      throw error;
    }
  }

  async delete(zohoItemId: string): Promise<void> {
    const identity = normalizeItemIdentity(zohoItemId);
    try {
      await this.prisma.fiscalItemProfile.delete({ where: { zohoItemId: identity } });
    } catch (error: unknown) {
      if (isPrismaRecordNotFound(error)) {
        throw new FiscalProfileNotFoundError("item");
      }
      throw error;
    }
  }
}
