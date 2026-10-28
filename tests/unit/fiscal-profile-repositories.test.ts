import { describe, expect, it, vi } from "vitest";

import type { FiscalCustomerProfile as CustomerRecord } from "../../src/application/fiscalization/fiscal-customer-profile-repository.js";
import type { FiscalItemProfile as ItemRecord } from "../../src/application/fiscalization/fiscal-item-profile-repository.js";
import type { PrismaClient as PostgresqlClient } from "../../src/generated/prisma/postgresql/client.js";
import { PostgresqlFiscalCustomerProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-customer-profile-repository.js";
import { PostgresqlFiscalItemProfileRepository } from "../../src/infrastructure/database/postgresql-fiscal-item-profile-repository.js";

const customerData = {
  companyName: "Example Ltd",
  clientPin: "P051234567X",
  headquarters: "Diani",
  address: "Main Road",
  postalCodeAndCity: "80400 Ukunda",
  exemptionNumber: null,
};

const itemData = {
  measureUnit: "EA",
  hsCode: "1234.56.78",
  hsName: "Consulting",
  vatClass: "A",
  vatGroupRate: "0",
};

function prismaRecordNotFound(): Error {
  return Object.assign(new Error("Record not found"), { code: "P2025" });
}

function createPrismaMock() {
  const customers = new Map<string, CustomerRecord>();
  const items = new Map<string, ItemRecord>();
  let nextId = 0;
  const createdAt = new Date("2026-10-27T00:00:00.000Z");

  const fiscalCustomerProfile = {
    findUnique: vi.fn(async ({ where }: { where: { zohoCustomerId: string } }) => {
      return customers.get(where.zohoCustomerId) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: typeof customerData & { zohoCustomerId: string } }) => {
      if (customers.has(data.zohoCustomerId)) {
        throw Object.assign(new Error("Unique constraint"), {
          code: "P2002",
          meta: { target: ["zohoCustomerId"] },
        });
      }

      const row = {
        ...data,
        id: `customer-profile-${++nextId}`,
        createdAt,
        updatedAt: createdAt,
      };
      customers.set(row.zohoCustomerId, row);
      return row;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { zohoCustomerId: string }; data: typeof customerData }) => {
        const existing = customers.get(where.zohoCustomerId);
        if (!existing) {
          throw prismaRecordNotFound();
        }

        const row = { ...existing, ...data, updatedAt: new Date(createdAt.getTime() + 1_000) };
        customers.set(where.zohoCustomerId, row);
        return row;
      },
    ),
    delete: vi.fn(async ({ where }: { where: { zohoCustomerId: string } }) => {
      if (!customers.delete(where.zohoCustomerId)) throw prismaRecordNotFound();
    }),
  };

  const fiscalItemProfile = {
    findUnique: vi.fn(async ({ where }: { where: { zohoItemId: string } }) => {
      return items.get(where.zohoItemId) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: typeof itemData & { zohoItemId: string } }) => {
      if (items.has(data.zohoItemId)) {
        throw Object.assign(new Error("Unique constraint"), {
          code: "P2002",
          meta: { driverAdapterError: { cause: { constraint: { index: "zohoItemId" } } } },
        });
      }

      const row = {
        ...data,
        id: `item-profile-${++nextId}`,
        createdAt,
        updatedAt: createdAt,
      };
      items.set(row.zohoItemId, row);
      return row;
    }),
    update: vi.fn(
      async ({ where, data }: { where: { zohoItemId: string }; data: typeof itemData }) => {
        const existing = items.get(where.zohoItemId);
        if (!existing) {
          throw prismaRecordNotFound();
        }

        const row = { ...existing, ...data, updatedAt: new Date(createdAt.getTime() + 1_000) };
        items.set(where.zohoItemId, row);
        return row;
      },
    ),
    delete: vi.fn(async ({ where }: { where: { zohoItemId: string } }) => {
      if (!items.delete(where.zohoItemId)) throw prismaRecordNotFound();
    }),
  };

  const prisma = { fiscalCustomerProfile, fiscalItemProfile };
  return {
    prisma,
    fiscalCustomerProfile,
    fiscalItemProfile,
  };
}

const providers = [
  {
    name: "PostgreSQL",
    createRepositories: (prisma: ReturnType<typeof createPrismaMock>["prisma"]) => ({
      customer: new PostgresqlFiscalCustomerProfileRepository(
        prisma as unknown as PostgresqlClient,
      ),
      item: new PostgresqlFiscalItemProfileRepository(prisma as unknown as PostgresqlClient),
    }),
  },
] as const;

describe.each(providers)("$name fiscal profile repository contract", ({ createRepositories }) => {
  it("creates and finds customer profiles by normalized Zoho identity", async () => {
    const mock = createPrismaMock();
    const { customer } = createRepositories(mock.prisma);

    const created = await customer.create({
      zohoCustomerId: " customer-1 ",
      ...customerData,
    });

    expect(created).toMatchObject({
      id: "customer-profile-1",
      zohoCustomerId: "customer-1",
      ...customerData,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    await expect(customer.findByZohoCustomerId("customer-1")).resolves.toEqual(created);
    await expect(customer.findByZohoCustomerId("missing-customer")).resolves.toBeNull();
  });

  it("rejects duplicate customer identities and updates mutable fields only", async () => {
    const mock = createPrismaMock();
    const { customer } = createRepositories(mock.prisma);
    const created = await customer.create({ zohoCustomerId: "customer-1", ...customerData });

    await expect(
      customer.create({ zohoCustomerId: "customer-1", ...customerData }),
    ).rejects.toMatchObject({ name: "DuplicateFiscalProfileError", kind: "customer" });

    const updated = await customer.update("customer-1", {
      ...customerData,
      companyName: "Updated Ltd",
    });
    expect(updated.id).toBe(created.id);
    expect(updated.zohoCustomerId).toBe("customer-1");
    expect(updated.companyName).toBe("Updated Ltd");
    expect(mock.fiscalCustomerProfile.update).toHaveBeenCalledWith({
      where: { zohoCustomerId: "customer-1" },
      data: { ...customerData, companyName: "Updated Ltd" },
    });

    await expect(customer.update("missing-customer", customerData)).rejects.toMatchObject({
      name: "FiscalProfileNotFoundError",
      kind: "customer",
    });
  });

  it("deletes customer profiles by normalized identity and reports missing records", async () => {
    const mock = createPrismaMock();
    const { customer } = createRepositories(mock.prisma);
    await customer.create({ zohoCustomerId: "customer-1", ...customerData });

    await expect(customer.delete(" customer-1 ")).resolves.toBeUndefined();
    await expect(customer.findByZohoCustomerId("customer-1")).resolves.toBeNull();
    await expect(customer.delete("missing-customer")).rejects.toMatchObject({
      name: "FiscalProfileNotFoundError",
      kind: "customer",
    });
  });

  it("creates and finds item profiles and keeps decimal strings intact", async () => {
    const mock = createPrismaMock();
    const { item } = createRepositories(mock.prisma);

    const created = await item.create({ zohoItemId: "item-1", ...itemData, vatGroupRate: "16.00" });

    expect(created).toMatchObject({
      id: "item-profile-1",
      zohoItemId: "item-1",
      ...itemData,
      vatGroupRate: "16.00",
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    await expect(item.findByZohoItemId("item-1")).resolves.toEqual(created);
    await expect(item.findByZohoItemId("missing-item")).resolves.toBeNull();
  });

  it("rejects duplicate items, updates mutable fields, and reports missing updates", async () => {
    const mock = createPrismaMock();
    const { item } = createRepositories(mock.prisma);
    const created = await item.create({ zohoItemId: "item-1", ...itemData });

    await expect(item.create({ zohoItemId: "item-1", ...itemData })).rejects.toMatchObject({
      name: "DuplicateFiscalProfileError",
      kind: "item",
    });

    const updated = await item.update("item-1", { ...itemData, hsName: "Updated" });
    expect(updated.id).toBe(created.id);
    expect(updated.zohoItemId).toBe("item-1");
    expect(updated.hsName).toBe("Updated");

    await expect(item.update("missing-item", itemData)).rejects.toMatchObject({
      name: "FiscalProfileNotFoundError",
      kind: "item",
    });
  });

  it("deletes item profiles by normalized identity and reports missing records", async () => {
    const mock = createPrismaMock();
    const { item } = createRepositories(mock.prisma);
    await item.create({ zohoItemId: "item-1", ...itemData });

    await expect(item.delete(" item-1 ")).resolves.toBeUndefined();
    await expect(item.findByZohoItemId("item-1")).resolves.toBeNull();
    await expect(item.delete("missing-item")).rejects.toMatchObject({
      name: "FiscalProfileNotFoundError",
      kind: "item",
    });
  });

  it("rejects invalid required fields and values that exceed schema bounds", async () => {
    const mock = createPrismaMock();
    const { customer, item } = createRepositories(mock.prisma);

    await expect(
      customer.create({ zohoCustomerId: "customer-1", ...customerData, companyName: " " }),
    ).rejects.toMatchObject({ name: "InvalidFiscalProfileError", field: "companyName" });

    await expect(
      item.create({ zohoItemId: "item-1", ...itemData, vatGroupRate: "sixteen" }),
    ).rejects.toMatchObject({ name: "InvalidFiscalProfileError", field: "vatGroupRate" });

    expect(mock.fiscalCustomerProfile.create).not.toHaveBeenCalled();
    expect(mock.fiscalItemProfile.create).not.toHaveBeenCalled();
  });
});
