import { buildFiscalizationSnapshot } from "../../src/application/fiscalization/fiscalization-snapshot.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";
import type { FiscalizationSnapshot } from "../../src/domain/fiscalization/fiscalization-snapshot.js";

export async function makeFiscalizationSnapshot(
  invoice: FiscalInvoiceCandidate,
  zohoOrganizationId = "organization-1",
): Promise<FiscalizationSnapshot> {
  const result = await buildFiscalizationSnapshot({
    invoice,
    zohoOrganizationId,
    registeredAt: new Date("2026-10-27T00:00:00.000Z"),
    customerProfiles: {
      async findByZohoCustomerId(zohoCustomerId) {
        return {
          id: "customer-profile-1",
          zohoCustomerId,
          companyName: "Example Ltd",
          clientPin: "P051234567X",
          headquarters: "Nairobi",
          address: "Main Road",
          postalCodeAndCity: "00100 Nairobi",
          exemptionNumber: null,
          createdAt: new Date("2026-10-26T00:00:00.000Z"),
          updatedAt: new Date("2026-10-26T00:00:00.000Z"),
        };
      },
    },
    itemProfiles: {
      async findByZohoItemId(zohoItemId) {
        return {
          id: "item-profile-1",
          zohoItemId,
          measureUnit: "EA",
          hsCode: "1234.56.78",
          hsName: "Test product",
          vatClass: "A",
          vatGroupRate: "16.00",
          createdAt: new Date("2026-10-26T00:00:00.000Z"),
          updatedAt: new Date("2026-10-26T00:00:00.000Z"),
        };
      },
    },
  });

  if (!result.success) {
    throw new Error(
      `Could not create fiscalization snapshot fixture: ${result.errors[0]?.message}`,
    );
  }
  return result.snapshot;
}
