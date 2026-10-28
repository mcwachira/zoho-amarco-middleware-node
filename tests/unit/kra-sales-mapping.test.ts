import { describe, expect, it, vi } from "vitest";
import {
  isKraSalesMappingOutput,
  kraSalesMappingConfigurationSchema,
  mapFiscalizationSnapshotToKraSalesRequest,
} from "../../src/application/etims/kra-sales-mapping.js";
import { KraEtimsReportingAdapter } from "../../src/integrations/etims/kra-etims-reporting-adapter.js";
import { KraVscuClient } from "../../src/integrations/etims/kra-vscu-client.js";
import {
  syntheticCalculationEvidence,
  syntheticConfiguration,
  syntheticContext,
  syntheticSnapshot,
} from "./kra-sales-mapping-fixture.js";

function map(
  provider: "oscu" | "vscu" = "vscu",
  configuration: unknown = syntheticConfiguration(provider),
  context: unknown = syntheticContext,
  calculationEvidence: unknown = syntheticCalculationEvidence,
) {
  return mapFiscalizationSnapshotToKraSalesRequest({
    snapshot: syntheticSnapshot,
    configuration,
    context,
    calculationEvidence,
  });
}

describe("versioned KRA sales mapping", () => {
  it.each(["oscu", "vscu"] as const)("maps a fully explicit synthetic %s request", (provider) => {
    const result = map(provider);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected structural mapping to succeed.");
    expect(result.readiness).toBe("structurally_valid_external_acceptance_unverified");
    expect(result.request).toMatchObject({
      tin: "SYNTHETIC01",
      bhfId: "ZZ",
      trdInvcNo: "SYNTHETIC-TRADER-INVOICE",
      totAmt: 348,
      itemList: [{ itemSeq: 1, itemCd: "SYNITEM", taxTyCd: "SYN" }],
    });
    expect(provider === "oscu" ? result.request : result.request).toHaveProperty(
      provider === "oscu" ? "cmcKey" : "salesTyCd",
      provider === "oscu" ? "SYNTHETIC-ONLY-NOT-A-SECRET" : "N",
    );
    expect(isKraSalesMappingOutput(result.request, provider)).toBe(true);
    expect(result.configurationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same request and configuration digest for repeated immutable inputs", () => {
    const first = map("vscu");
    const second = map("vscu");
    expect(first).toEqual(second);
    if (first.success) {
      expect(Object.isFrozen(first.request)).toBe(true);
      expect(Object.isFrozen(first.request.itemList)).toBe(true);
      expect(Object.isFrozen(first.request.itemList[0])).toBe(true);
    }
  });

  it("rejects unsupported configuration versions and unknown fields", () => {
    expect(map("vscu", { ...syntheticConfiguration("vscu"), schemaVersion: 2 })).toMatchObject({
      success: false,
      stage: "configuration",
      errors: [{ field: "configuration.schemaVersion" }],
    });
    expect(
      kraSalesMappingConfigurationSchema.safeParse({
        ...syntheticConfiguration("vscu"),
        extra: true,
      }).success,
    ).toBe(false);
  });

  it.each([
    ["missing taxpayer", { ...syntheticConfiguration("vscu"), taxpayer: undefined }],
    ["missing item mapping", { ...syntheticConfiguration("vscu"), itemMappings: [] }],
    ["missing tax mapping", { ...syntheticConfiguration("vscu"), taxMappings: [] }],
    [
      "duplicate item key",
      {
        ...syntheticConfiguration("vscu"),
        itemMappings: [
          ...syntheticConfiguration("vscu").itemMappings,
          ...syntheticConfiguration("vscu").itemMappings,
        ],
      },
    ],
    [
      "duplicate tax key",
      {
        ...syntheticConfiguration("vscu"),
        taxMappings: [
          ...syntheticConfiguration("vscu").taxMappings,
          ...syntheticConfiguration("vscu").taxMappings,
        ],
      },
    ],
    [
      "unapproved sequence policy",
      {
        ...syntheticConfiguration("vscu"),
        sequencePolicy: {
          ...syntheticConfiguration("vscu").sequencePolicy,
          externalAllocationRequired: false,
        },
      },
    ],
  ])("rejects %s configuration", (_label, configuration) => {
    expect(map("vscu", configuration).success).toBe(false);
  });

  it("rejects missing/invalid dates, sequence allocation, and provider fields", () => {
    expect(map("vscu", undefined, { ...syntheticContext, salesDt: "20260230" })).toMatchObject({
      success: false,
      stage: "structure",
    });
    expect(map("vscu", undefined, { ...syntheticContext, allocationReference: "" })).toMatchObject({
      success: false,
      stage: "configuration",
    });
    expect(
      map("oscu", {
        ...syntheticConfiguration("oscu"),
        taxpayer: { ...syntheticConfiguration("oscu").taxpayer, cmcKey: undefined },
      }),
    ).toMatchObject({
      success: false,
      stage: "configuration",
      errors: [{ field: "taxpayer.cmcKey" }],
    });
    expect(map("vscu", undefined, { ...syntheticContext, rptNo: undefined })).toMatchObject({
      success: false,
      stage: "configuration",
      errors: [{ field: "context.rptNo" }],
    });
  });

  it("rejects calculation evidence for a different snapshot, policy, or precision", () => {
    expect(
      map("vscu", undefined, undefined, {
        ...syntheticCalculationEvidence,
        snapshotId: "b".repeat(64),
      }),
    ).toMatchObject({ success: false, stage: "evidence" });
    expect(
      map("vscu", undefined, undefined, {
        ...syntheticCalculationEvidence,
        policyVersion: "other",
      }),
    ).toMatchObject({ success: false, stage: "evidence" });
    expect(
      map("vscu", undefined, undefined, { ...syntheticCalculationEvidence, totAmt: "348.001" }),
    ).toMatchObject({ success: false, stage: "evidence" });
  });

  it("rejects unknown item/tax IDs and an unrepresentable payment label instead of guessing", () => {
    const missingItem = {
      ...syntheticSnapshot,
      invoice: {
        ...syntheticSnapshot.invoice,
        lines: [{ ...syntheticSnapshot.invoice.lines[0]!, itemId: "unmapped" }],
      },
    };
    expect(
      mapFiscalizationSnapshotToKraSalesRequest({
        snapshot: missingItem,
        configuration: syntheticConfiguration("vscu"),
        context: syntheticContext,
        calculationEvidence: syntheticCalculationEvidence,
      }),
    ).toMatchObject({ success: false, stage: "configuration" });
    const missingTax = {
      ...syntheticSnapshot,
      invoice: {
        ...syntheticSnapshot.invoice,
        lines: [{ ...syntheticSnapshot.invoice.lines[0]!, taxId: "unknown-tax" }],
      },
    };
    expect(
      mapFiscalizationSnapshotToKraSalesRequest({
        snapshot: missingTax,
        configuration: syntheticConfiguration("vscu"),
        context: syntheticContext,
        calculationEvidence: syntheticCalculationEvidence,
      }),
    ).toMatchObject({ success: false, stage: "configuration" });
    expect(
      map("vscu", undefined, undefined, {
        ...syntheticCalculationEvidence,
        lines: [{ ...syntheticCalculationEvidence.lines[0]!, taxblAmt: "300.001" }],
      }),
    ).toMatchObject({ success: false, stage: "evidence" });
  });

  it("requires exact payment ID evidence and an explicit payment-method mapping", () => {
    const snapshot = {
      ...syntheticSnapshot,
      payments: [
        {
          paymentId: "synthetic-payment-id",
          paymentNumber: null,
          paymentMode: "Synthetic label; not used as a key",
          amount: "348",
          date: null,
          referenceNumber: null,
          description: null,
          source: { responseSha256: "c".repeat(64) },
        },
      ],
    };
    const paymentEvidence = {
      ...syntheticCalculationEvidence,
      payments: [
        { paymentId: "synthetic-payment-id", sourcePaymentMethodId: "synthetic-method-id" },
      ],
    };
    expect(
      mapFiscalizationSnapshotToKraSalesRequest({
        snapshot,
        configuration: syntheticConfiguration("vscu"),
        context: syntheticContext,
        calculationEvidence: paymentEvidence,
      }),
    ).toMatchObject({
      success: false,
      stage: "configuration",
      errors: [{ field: "paymentMappings" }],
    });

    const config = {
      ...syntheticConfiguration("vscu"),
      paymentMappings: [{ sourcePaymentMethodId: "synthetic-method-id", pmtTyCd: "SYN" }],
    };
    const result = mapFiscalizationSnapshotToKraSalesRequest({
      snapshot,
      configuration: config,
      context: syntheticContext,
      calculationEvidence: paymentEvidence,
    });
    expect(result).toMatchObject({ success: true, request: { pmtTyCd: "SYN" } });
  });

  it("does not let raw payloads bypass mapping or let structural success open the production gate", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = new KraEtimsReportingAdapter(
      new KraVscuClient({ baseUrl: "http://127.0.0.1:8088", fetchImpl }),
    );
    const mapped = map("vscu");
    if (!mapped.success) throw new Error("Expected the synthetic request to map.");
    const prepared = {
      operationId: "synthetic-operation",
      fiscalizationRequestId: "synthetic-request",
      zohoInvoiceId: syntheticSnapshot.invoice.zohoInvoiceId,
      correlationId: "synthetic-correlation",
      payloadHash: "a".repeat(64),
      payload: mapped.request,
    };
    expect(await adapter.validate({ ...prepared, payload: { ...mapped.request } })).toContain(
      "kraSales.mapping: Request must be produced by the versioned KRA mapping engine.",
    );
    expect(await adapter.validate(prepared)).toEqual([]);
    await expect(adapter.submit(prepared)).resolves.toMatchObject({
      kind: "not_submitted",
      errorCategory: "submission_activation_closed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
