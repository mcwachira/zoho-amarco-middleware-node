import type {
  FiscalCustomerProfile,
  FiscalCustomerProfileData,
  FiscalCustomerProfileRepository,
  NewFiscalCustomerProfile,
} from "../../application/fiscalization/fiscal-customer-profile-repository.js";
import {
  DuplicateFiscalProfileError,
  FiscalProfileNotFoundError,
} from "../../application/fiscalization/fiscal-profile-errors.js";
import {
  normalizeCustomerIdentity,
  normalizeCustomerProfileData,
  normalizeNewCustomerProfile,
} from "../../application/fiscalization/fiscal-profile-validation.js";
import type { FiscalCustomerProfile as PrismaFiscalCustomerProfile } from "../../generated/prisma/postgresql/client.js";
import type { PrismaClient } from "../../generated/prisma/postgresql/client.js";
import {
  isPrismaRecordNotFound,
  isProfileIdentityConflict,
} from "./fiscal-profile-prisma-errors.js";

function toDomainProfile(row: PrismaFiscalCustomerProfile): FiscalCustomerProfile {
  return {
    id: row.id,
    zohoCustomerId: row.zohoCustomerId,
    companyName: row.companyName,
    clientPin: row.clientPin,
    headquarters: row.headquarters,
    address: row.address,
    postalCodeAndCity: row.postalCodeAndCity,
    exemptionNumber: row.exemptionNumber,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PostgresqlFiscalCustomerProfileRepository implements FiscalCustomerProfileRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async findByZohoCustomerId(zohoCustomerId: string): Promise<FiscalCustomerProfile | null> {
    const identity = normalizeCustomerIdentity(zohoCustomerId);
    const row = await this.prisma.fiscalCustomerProfile.findUnique({
      where: { zohoCustomerId: identity },
    });

    return row === null ? null : toDomainProfile(row);
  }

  async create(profile: NewFiscalCustomerProfile): Promise<FiscalCustomerProfile> {
    const normalized = normalizeNewCustomerProfile(profile);

    try {
      const row = await this.prisma.fiscalCustomerProfile.create({ data: normalized });
      return toDomainProfile(row);
    } catch (error: unknown) {
      if (isProfileIdentityConflict(error, "zohoCustomerId")) {
        throw new DuplicateFiscalProfileError("customer");
      }

      throw error;
    }
  }

  async update(
    zohoCustomerId: string,
    profile: FiscalCustomerProfileData,
  ): Promise<FiscalCustomerProfile> {
    const identity = normalizeCustomerIdentity(zohoCustomerId);
    const normalized = normalizeCustomerProfileData(profile);

    try {
      const row = await this.prisma.fiscalCustomerProfile.update({
        where: { zohoCustomerId: identity },
        data: normalized,
      });

      return toDomainProfile(row);
    } catch (error: unknown) {
      if (isPrismaRecordNotFound(error)) {
        throw new FiscalProfileNotFoundError("customer");
      }

      throw error;
    }
  }
}
