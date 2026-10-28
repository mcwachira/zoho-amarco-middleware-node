import type { FiscalizationSnapshot } from "../../src/domain/fiscalization/fiscalization-snapshot.js";
import {
  mapFiscalizationSnapshotToKraSalesRequest,
  type KraSalesMappingConfiguration,
} from "../../src/application/etims/kra-sales-mapping.js";

export const syntheticSnapshot: FiscalizationSnapshot = {
  schemaVersion: 1,
  snapshotId: "a".repeat(64),
  registeredAt: "2026-10-27T12:00:00.000Z",
  zohoOrganizationId: "synthetic-organization",
  invoice: {
    zohoInvoiceId: "synthetic-invoice-id",
    invoiceNumber: "SYNTHETIC-INVOICE",
    customerId: "synthetic-customer-id",
    customerName: "Synthetic customer",
    currencyCode: "KES",
    lines: [
      {
        sourceLineId: "synthetic-line-id",
        itemId: "synthetic-item-id",
        description: "Synthetic item label; not used as a KRA code",
        quantity: "1",
        unitPrice: "348",
        lineTotal: "348",
        taxId: "synthetic-tax-id",
        taxName: "Synthetic label; not used for mapping",
        taxType: "tax",
        taxPercentage: "16",
      },
    ],
    subtotal: "300",
    taxTotal: "48",
    total: "348",
  },
  customer: {
    zohoCustomerId: "synthetic-customer-id",
    companyName: "Synthetic Customer",
    clientPin: "SYNTHETIC01",
    headquarters: "Synthetic",
    address: "Synthetic",
    postalCodeAndCity: "00000 Synthetic",
    exemptionNumber: null,
    traderSystemInvoiceNumber: "SYNTHETIC-INVOICE",
  },
  lineProfiles: [
    {
      sourceLineId: "synthetic-line-id",
      zohoItemId: "synthetic-item-id",
      measureUnit: "EA",
      hsCode: "SYNTHETIC",
      hsName: "Synthetic item",
      vatClass: "?",
      vatGroupRate: "0",
    },
  ],
  payments: [],
};

export function syntheticConfiguration(provider: "oscu" | "vscu"): KraSalesMappingConfiguration {
  return {
    schemaVersion: 1,
    configurationId: "synthetic-config-v1",
    policyVersion: "synthetic-policy-v1",
    provider,
    taxpayer: {
      tin: "SYNTHETIC01",
      bhfId: "ZZ",
      regrId: "SYNTHETIC",
      regrNm: "Synthetic registrant",
      modrId: "SYNTHETIC",
      modrNm: "Synthetic modifier",
      ...(provider === "oscu" ? { cmcKey: "SYNTHETIC-ONLY-NOT-A-SECRET" } : {}),
    },
    document: {
      rcptTyCd: "SYN",
      salesSttsCd: "SYN",
      prchrAcptcYn: "N",
      mapCustomerPin: true,
      paymentRequired: false,
    },
    sequencePolicy: {
      policyId: "synthetic-external-allocator",
      version: "synthetic-v1",
      externalAllocationRequired: true,
    },
    datePolicy: {
      policyId: "synthetic-preformatted-values",
      version: "synthetic-v1",
      timeZone: "Etc/UTC",
      valuesArePreformatted: true,
    },
    itemMappings: [
      {
        sourceItemId: "synthetic-item-id",
        itemClsCd: "SYNCLS",
        itemCd: "SYNITEM",
        itemNm: "Synthetic item",
        pkgUnitCd: "SYN",
        qtyUnitCd: "SYN",
        bcd: null,
        isrccCd: null,
        isrccNm: null,
        isrcRt: null,
      },
    ],
    taxMappings: [{ sourceTaxId: "synthetic-tax-id", taxTyCd: "SYN", bucket: "A", rate: "16" }],
    paymentMappings: [],
  };
}

export const syntheticContext = {
  traderInvoiceNumber: "SYNTHETIC-TRADER-INVOICE",
  cfmDt: "20261027123456",
  salesDt: "20261027",
  rcptPbctDt: "20261027123456",
  invcNo: 1,
  orgInvcNo: 0,
  rptNo: 1,
  allocationReference: "synthetic-allocator-reference",
};

export const syntheticCalculationEvidence = {
  snapshotId: syntheticSnapshot.snapshotId,
  policyVersion: "synthetic-policy-v1",
  lines: [
    {
      sourceLineId: "synthetic-line-id",
      pkg: "1",
      qty: "1",
      prc: "348",
      splyAmt: "348",
      dcRt: "0",
      dcAmt: "0",
      taxblAmt: "300",
      totTaxAmt: "48",
      totAmt: "348",
    },
  ],
  payments: [],
  buckets: {
    A: { taxblAmt: "300", taxRt: "16", taxAmt: "48" },
    B: { taxblAmt: "0", taxRt: "0", taxAmt: "0" },
    C: { taxblAmt: "0", taxRt: "0", taxAmt: "0" },
    D: { taxblAmt: "0", taxRt: "0", taxAmt: "0" },
    E: { taxblAmt: "0", taxRt: "0", taxAmt: "0" },
  },
  totTaxblAmt: "300",
  totTaxAmt: "48",
  totAmt: "348",
};

export function syntheticMappedRequest(provider: "oscu" | "vscu") {
  const result = mapFiscalizationSnapshotToKraSalesRequest({
    snapshot: syntheticSnapshot,
    configuration: syntheticConfiguration(provider),
    context: syntheticContext,
    calculationEvidence: syntheticCalculationEvidence,
  });
  if (!result.success) throw new Error(`Synthetic mapping failed: ${result.errors[0]?.field}`);
  return result.request;
}
