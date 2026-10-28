import { createHash } from "node:crypto";
import { z } from "zod";

import type { FiscalizationSnapshot } from "../../domain/fiscalization/fiscalization-snapshot.js";
import {
  kraDecimalToNumber,
  kraOscuSalesRequestSchema,
  kraVscuSalesRequestSchema,
  isKraSalesRequestMapped,
  markKraSalesRequestMapped,
  validateKraSalesRequest,
  type KraOscuSalesRequest,
  type KraVscuSalesRequest,
} from "../../integrations/etims/kra-protocol-client.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const decimal = z.string().regex(/^(0|[1-9]\d{0,15})(?:\.\d{1,2})?$/);
const taxBucket = z.enum(["A", "B", "C", "D", "E"]);
const timeZone = text(100).refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "must be a recognized IANA timezone identifier");

const taxpayerSchema = z
  .object({
    tin: z.string().length(11),
    bhfId: z.string().length(2),
    regrId: text(20),
    regrNm: text(60),
    modrId: text(20),
    modrNm: text(60),
    cmcKey: z.string().min(1).max(255).optional(),
  })
  .strict();

const itemMappingSchema = z
  .object({
    sourceItemId: text(255),
    itemClsCd: z.string().max(10).nullable(),
    itemCd: text(20),
    itemNm: text(200),
    pkgUnitCd: text(5),
    qtyUnitCd: text(5),
    bcd: z.string().max(20).nullable(),
    isrccCd: z.string().max(10).nullable(),
    isrccNm: z.string().max(100).nullable(),
    isrcRt: z.number().int().nonnegative().max(999).nullable(),
  })
  .strict();

const taxMappingSchema = z
  .object({
    sourceTaxId: text(255),
    taxTyCd: text(5),
    bucket: taxBucket,
    rate: decimal,
  })
  .strict();

const paymentMappingSchema = z
  .object({ sourcePaymentMethodId: text(255), pmtTyCd: text(5) })
  .strict();

export const kraSalesMappingConfigurationSchema = z
  .object({
    schemaVersion: z.literal(1),
    configurationId: text(100),
    policyVersion: text(100),
    provider: z.enum(["oscu", "vscu"]),
    taxpayer: taxpayerSchema,
    document: z
      .object({
        rcptTyCd: text(5),
        salesSttsCd: text(5),
        prchrAcptcYn: z.enum(["Y", "N"]),
        mapCustomerPin: z.boolean(),
        paymentRequired: z.boolean(),
      })
      .strict(),
    sequencePolicy: z
      .object({
        policyId: text(100),
        version: text(100),
        externalAllocationRequired: z.literal(true),
      })
      .strict(),
    datePolicy: z
      .object({
        policyId: text(100),
        version: text(100),
        timeZone,
        valuesArePreformatted: z.literal(true),
      })
      .strict(),
    itemMappings: z.array(itemMappingSchema).max(10_000),
    taxMappings: z.array(taxMappingSchema).max(10_000),
    paymentMappings: z.array(paymentMappingSchema).max(1_000),
  })
  .strict();

export type KraSalesMappingConfiguration = z.infer<typeof kraSalesMappingConfigurationSchema>;

const amountLineSchema = z
  .object({
    sourceLineId: text(255),
    pkg: decimal,
    qty: decimal,
    prc: decimal,
    splyAmt: decimal,
    dcRt: decimal,
    dcAmt: decimal,
    taxblAmt: decimal,
    totTaxAmt: decimal,
    totAmt: decimal,
  })
  .strict();

const amountBucketSchema = z
  .object({ taxblAmt: decimal, taxRt: decimal, taxAmt: decimal })
  .strict();
const bucketsSchema = z
  .object({
    A: amountBucketSchema,
    B: amountBucketSchema,
    C: amountBucketSchema,
    D: amountBucketSchema,
    E: amountBucketSchema,
  })
  .strict();

/** Explicit fiscal calculation evidence. This module validates and transports it; it never calculates tax. */
export const kraSalesCalculationEvidenceSchema = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    policyVersion: text(100),
    lines: z.array(amountLineSchema).min(1).max(999),
    payments: z
      .array(z.object({ paymentId: text(255), sourcePaymentMethodId: text(255) }).strict())
      .max(100),
    buckets: bucketsSchema,
    totTaxblAmt: decimal,
    totTaxAmt: decimal,
    totAmt: decimal,
  })
  .strict();
export type KraSalesCalculationEvidence = z.infer<typeof kraSalesCalculationEvidenceSchema>;

export const kraSalesMappingContextSchema = z
  .object({
    traderInvoiceNumber: text(50),
    cfmDt: z.string().regex(/^\d{14}$/),
    salesDt: z.string().regex(/^\d{8}$/),
    rcptPbctDt: z.string().regex(/^\d{14}$/),
    invcNo: z.number().int().nonnegative().safe(),
    orgInvcNo: z.number().int().nonnegative().safe(),
    rptNo: z.number().int().nonnegative().safe().optional(),
    allocationReference: text(200),
  })
  .strict();
export type KraSalesMappingContext = z.infer<typeof kraSalesMappingContextSchema>;

export type KraSalesMappingFailure = {
  readonly success: false;
  readonly stage: "source" | "configuration" | "evidence" | "structure";
  readonly errors: readonly { readonly field: string; readonly message: string }[];
};

export type KraSalesMappingSuccess = {
  readonly success: true;
  readonly provider: "oscu" | "vscu";
  readonly request: KraOscuSalesRequest | KraVscuSalesRequest;
  readonly configurationId: string;
  readonly configurationDigest: string;
  readonly policyVersion: string;
  readonly snapshotId: string;
  readonly allocationReference: string;
  readonly readiness: "structurally_valid_external_acceptance_unverified";
};

export type KraSalesMappingResult = KraSalesMappingSuccess | KraSalesMappingFailure;

export function isKraSalesMappingOutput(
  value: unknown,
  provider: "oscu" | "vscu",
): value is KraOscuSalesRequest | KraVscuSalesRequest {
  return typeof value === "object" && value !== null && isKraSalesRequestMapped(value, provider);
}

function fail(
  stage: KraSalesMappingFailure["stage"],
  field: string,
  message: string,
): KraSalesMappingFailure {
  return { success: false, stage, errors: [{ field, message }] };
}

function decimalCents(value: string): bigint {
  const match = /^(0|[1-9]\d{0,15})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("invalid decimal");
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export function digestKraSalesMappingConfiguration(configuration: unknown): string {
  const parsed = kraSalesMappingConfigurationSchema.parse(configuration);
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(parsed)))
    .digest("hex");
}

function validateUniqueMappings(
  config: KraSalesMappingConfiguration,
): KraSalesMappingFailure | null {
  const duplicate = (field: string, values: readonly string[]): KraSalesMappingFailure | null => {
    const seen = new Set<string>();
    for (const identity of values) {
      if (seen.has(identity)) {
        return fail(
          "configuration",
          field,
          "Duplicate mapping key; keep one entry for each stable source identifier.",
        );
      }
      seen.add(identity);
    }
    return null;
  };
  return (
    duplicate(
      "itemMappings",
      config.itemMappings.map((entry) => entry.sourceItemId),
    ) ??
    duplicate(
      "taxMappings",
      config.taxMappings.map((entry) => entry.sourceTaxId),
    ) ??
    duplicate(
      "paymentMappings",
      config.paymentMappings.map((entry) => entry.sourcePaymentMethodId),
    )
  );
}

/** Build a local structural request. External acceptance/readiness is always unresolved here. */
export function mapFiscalizationSnapshotToKraSalesRequest(input: {
  readonly snapshot: FiscalizationSnapshot;
  readonly configuration: unknown;
  readonly context: unknown;
  readonly calculationEvidence: unknown;
}): KraSalesMappingResult {
  if (
    typeof input.configuration === "object" &&
    input.configuration !== null &&
    "schemaVersion" in input.configuration &&
    input.configuration.schemaVersion !== 1
  ) {
    return fail(
      "configuration",
      "configuration.schemaVersion",
      "Unsupported KRA mapping configuration version.",
    );
  }
  const configResult = kraSalesMappingConfigurationSchema.safeParse(input.configuration);
  if (!configResult.success) {
    return {
      success: false,
      stage: "configuration",
      errors: configResult.error.issues.map((issue) => ({
        field: `configuration.${issue.path.map(String).join(".") || "root"}`,
        message: issue.message,
      })),
    };
  }
  const config = configResult.data;
  const uniqueError = validateUniqueMappings(config);
  if (uniqueError) return uniqueError;

  const contextResult = kraSalesMappingContextSchema.safeParse(input.context);
  if (!contextResult.success) {
    return {
      success: false,
      stage: "configuration",
      errors: contextResult.error.issues.map((issue) => ({
        field: `context.${issue.path.map(String).join(".") || "root"}`,
        message: issue.message,
      })),
    };
  }
  const context = contextResult.data;
  if (config.provider === "oscu" && !config.taxpayer.cmcKey) {
    return fail(
      "configuration",
      "taxpayer.cmcKey",
      "OSCU requires an explicitly configured cmcKey.",
    );
  }
  if (config.provider === "vscu" && context.rptNo === undefined) {
    return fail(
      "configuration",
      "context.rptNo",
      "VSCU requires an explicitly allocated report number.",
    );
  }

  const evidenceResult = kraSalesCalculationEvidenceSchema.safeParse(input.calculationEvidence);
  if (!evidenceResult.success) {
    return {
      success: false,
      stage: "evidence",
      errors: evidenceResult.error.issues.map((issue) => ({
        field: `calculationEvidence.${issue.path.map(String).join(".") || "root"}`,
        message: issue.message,
      })),
    };
  }
  const evidence = evidenceResult.data;
  if (evidence.snapshotId !== input.snapshot.snapshotId) {
    return fail(
      "evidence",
      "calculationEvidence.snapshotId",
      "Fiscal calculation evidence belongs to a different immutable snapshot.",
    );
  }
  if (evidence.policyVersion !== config.policyVersion) {
    return fail(
      "evidence",
      "calculationEvidence.policyVersion",
      "Calculation evidence and mapping configuration policy versions differ.",
    );
  }
  if (input.snapshot.invoice.currencyCode !== "KES") {
    return fail(
      "source",
      "invoice.currencyCode",
      "Only KES source invoices are supported by the current KRA request schema.",
    );
  }
  if (
    evidence.lines.length !== input.snapshot.invoice.lines.length ||
    evidence.lines.some(
      (line, index) => line.sourceLineId !== input.snapshot.invoice.lines[index]?.sourceLineId,
    )
  ) {
    return fail(
      "evidence",
      "calculationEvidence.lines",
      "Calculation evidence must contain exactly one line in source invoice order for every snapshot line.",
    );
  }
  if (evidence.lines.length > 999) {
    return fail(
      "source",
      "invoice.lines",
      "KRA item sequence values are limited to 999 by the request contract.",
    );
  }
  try {
    if (
      decimalCents(evidence.totAmt) !== decimalCents(input.snapshot.invoice.total) ||
      decimalCents(evidence.totTaxAmt) !== decimalCents(input.snapshot.invoice.taxTotal)
    ) {
      return fail(
        "evidence",
        "calculationEvidence.totals",
        "Mapped fiscal totals must agree with the immutable Zoho invoice total and tax total.",
      );
    }
  } catch {
    return fail(
      "evidence",
      "calculationEvidence.totals",
      "Source totals must be non-negative KRA amounts with at most two decimal places.",
    );
  }

  const itemById = new Map(config.itemMappings.map((entry) => [entry.sourceItemId, entry]));
  const taxById = new Map(config.taxMappings.map((entry) => [entry.sourceTaxId, entry]));
  const paymentByMethodId = new Map(
    config.paymentMappings.map((entry) => [entry.sourcePaymentMethodId, entry.pmtTyCd]),
  );
  const lineProfiles = new Map(
    input.snapshot.lineProfiles.map((profile) => [profile.sourceLineId, profile]),
  );
  const mappedLines: Record<string, unknown>[] = [];
  const observedTaxByBucket = new Map<
    string,
    { readonly rate: bigint; taxable: bigint; tax: bigint }
  >();

  for (const [index, source] of input.snapshot.invoice.lines.entries()) {
    const item = itemById.get(source.itemId ?? "");
    if (!item)
      return fail(
        "configuration",
        `itemMappings[${index}]`,
        "Add an item mapping keyed by the exact Zoho item ID.",
      );
    const tax = source.taxId ? taxById.get(source.taxId) : undefined;
    if (!tax)
      return fail(
        "configuration",
        `taxMappings[${index}]`,
        "Add an explicit tax mapping keyed by the exact Zoho tax ID; tax names and percentages are not used for matching.",
      );
    const lineEvidence = evidence.lines[index]!;
    try {
      for (const field of [
        "pkg",
        "qty",
        "prc",
        "splyAmt",
        "dcRt",
        "dcAmt",
        "taxblAmt",
        "totTaxAmt",
        "totAmt",
      ] as const) {
        kraDecimalToNumber(lineEvidence[field]);
      }
      kraDecimalToNumber(tax.rate);
      if (
        decimalCents(lineEvidence.qty) !== decimalCents(source.quantity) ||
        decimalCents(lineEvidence.prc) !== decimalCents(source.unitPrice)
      ) {
        return fail(
          "evidence",
          `calculationEvidence.lines[${index}]`,
          "Mapped quantity and unit price must agree with the immutable source line at supported KRA precision.",
        );
      }
    } catch {
      return fail(
        "evidence",
        `calculationEvidence.lines[${index}]`,
        "Fiscal amount or configured tax rate is outside the supported KRA decimal precision/range.",
      );
    }
    const taxRateCents = decimalCents(tax.rate);
    const bucket = observedTaxByBucket.get(tax.bucket);
    if (bucket && bucket.rate !== taxRateCents) {
      return fail(
        "configuration",
        `taxMappings.${tax.bucket}`,
        "Mappings assigned to one KRA tax bucket must use one explicitly agreed rate.",
      );
    }
    const totals = bucket ?? { rate: taxRateCents, taxable: 0n, tax: 0n };
    try {
      totals.taxable += decimalCents(lineEvidence.taxblAmt);
      totals.tax += decimalCents(lineEvidence.totTaxAmt);
    } catch {
      return fail(
        "evidence",
        `calculationEvidence.lines[${index}]`,
        "Taxable and tax amounts must use supported non-negative decimal values.",
      );
    }
    observedTaxByBucket.set(tax.bucket, totals);
    const profile = lineProfiles.get(source.sourceLineId ?? "");
    if (!profile || profile.zohoItemId !== source.itemId) {
      return fail(
        "source",
        `invoice.lines[${index}]`,
        "Snapshot item profile does not match the source invoice line.",
      );
    }
    mappedLines.push({
      itemSeq: index + 1,
      itemClsCd: item.itemClsCd,
      itemCd: item.itemCd,
      itemNm: item.itemNm,
      bcd: item.bcd,
      pkgUnitCd: item.pkgUnitCd,
      pkg: kraDecimalToNumber(lineEvidence.pkg),
      qtyUnitCd: item.qtyUnitCd,
      qty: kraDecimalToNumber(lineEvidence.qty),
      prc: kraDecimalToNumber(lineEvidence.prc),
      splyAmt: kraDecimalToNumber(lineEvidence.splyAmt),
      dcRt: kraDecimalToNumber(lineEvidence.dcRt),
      dcAmt: kraDecimalToNumber(lineEvidence.dcAmt),
      isrccCd: item.isrccCd,
      isrccNm: item.isrccNm,
      isrcRt: item.isrcRt,
      taxTyCd: tax.taxTyCd,
      taxblAmt: kraDecimalToNumber(lineEvidence.taxblAmt),
      totTaxAmt: kraDecimalToNumber(lineEvidence.totTaxAmt),
      totAmt: kraDecimalToNumber(lineEvidence.totAmt),
    });
  }

  const buckets: Record<string, number> = {};
  for (const key of ["A", "B", "C", "D", "E"] as const) {
    const actual = observedTaxByBucket.get(key);
    const supplied = evidence.buckets[key];
    if (actual && actual.rate !== decimalCents(supplied.taxRt)) {
      return fail(
        "evidence",
        `calculationEvidence.buckets.${key}.taxRt`,
        "Bucket rate does not match the explicitly mapped tax rate.",
      );
    }
    let taxable: bigint;
    let tax: bigint;
    try {
      taxable = decimalCents(supplied.taxblAmt);
      tax = decimalCents(supplied.taxAmt);
      const rate = decimalCents(supplied.taxRt);
      if (taxable !== (actual?.taxable ?? 0n) || tax !== (actual?.tax ?? 0n)) {
        return fail(
          "evidence",
          `calculationEvidence.buckets.${key}`,
          "Tax bucket amounts do not equal the sum of their mapped invoice lines.",
        );
      }
      if (!actual && (taxable !== 0n || tax !== 0n || rate !== 0n)) {
        return fail(
          "evidence",
          `calculationEvidence.buckets.${key}`,
          "Unused tax buckets must be zero until a source tax mapping assigns them.",
        );
      }
      kraDecimalToNumber(supplied.taxRt);
    } catch {
      return fail(
        "evidence",
        `calculationEvidence.buckets.${key}`,
        "Tax bucket values must use supported KRA decimal precision and range.",
      );
    }
    buckets[`taxblAmt${key}`] = kraDecimalToNumber(supplied.taxblAmt);
    buckets[`taxRt${key}`] = kraDecimalToNumber(supplied.taxRt);
    buckets[`taxAmt${key}`] = kraDecimalToNumber(supplied.taxAmt);
  }
  const bucketTaxable = ["A", "B", "C", "D", "E"].reduce(
    (sum, key) => sum + (observedTaxByBucket.get(key)?.taxable ?? 0n),
    0n,
  );
  const bucketTax = ["A", "B", "C", "D", "E"].reduce(
    (sum, key) => sum + (observedTaxByBucket.get(key)?.tax ?? 0n),
    0n,
  );
  try {
    if (
      bucketTaxable !== decimalCents(evidence.totTaxblAmt) ||
      bucketTax !== decimalCents(evidence.totTaxAmt)
    ) {
      return fail(
        "evidence",
        "calculationEvidence.totals",
        "Header taxable and tax totals must equal the sum of the five explicit tax buckets.",
      );
    }
  } catch {
    return fail(
      "evidence",
      "calculationEvidence.totals",
      "Header totals must use supported non-negative decimal values.",
    );
  }

  const snapshotPayments = input.snapshot.payments ?? [];
  const evidencePayments = new Map<string, string>();
  for (const payment of evidence.payments) {
    if (evidencePayments.has(payment.paymentId)) {
      return fail(
        "evidence",
        "calculationEvidence.payments",
        "Payment mapping evidence contains a duplicate payment identifier.",
      );
    }
    evidencePayments.set(payment.paymentId, payment.sourcePaymentMethodId);
  }
  if (
    snapshotPayments.length !== evidencePayments.size ||
    snapshotPayments.some((payment) => !evidencePayments.has(payment.paymentId))
  ) {
    return fail(
      "evidence",
      "calculationEvidence.payments",
      "Payment mapping evidence must identify every payment in the immutable snapshot exactly once.",
    );
  }
  const paymentCodes = new Set<string>();
  for (const payment of snapshotPayments) {
    const sourceMethodId = evidencePayments.get(payment.paymentId);
    const mappedCode = sourceMethodId ? paymentByMethodId.get(sourceMethodId) : undefined;
    if (!mappedCode) {
      return fail(
        "configuration",
        "paymentMappings",
        "Add an explicit payment mapping keyed by the stable payment-method identifier in fiscal calculation evidence.",
      );
    }
    paymentCodes.add(mappedCode);
  }
  if (paymentCodes.size > 1) {
    return fail(
      "configuration",
      "paymentMappings",
      "The request contract has one payment code; this invoice has multiple mapped payment codes.",
    );
  }
  if (config.document.paymentRequired && paymentCodes.size === 0) {
    return fail(
      "configuration",
      "paymentMappings",
      "An explicit payment mapping is required, but the snapshot contains no mapped payment evidence.",
    );
  }

  const customerPin = config.document.mapCustomerPin
    ? input.snapshot.customer.clientPin
    : undefined;
  const common = {
    tin: config.taxpayer.tin,
    bhfId: config.taxpayer.bhfId,
    trdInvcNo: context.traderInvoiceNumber,
    invcNo: context.invcNo,
    orgInvcNo: context.orgInvcNo,
    ...(customerPin ? { custTin: customerPin } : {}),
    ...(input.snapshot.invoice.customerName ? { custNm: input.snapshot.invoice.customerName } : {}),
    rcptTyCd: config.document.rcptTyCd,
    ...(paymentCodes.size === 1 ? { pmtTyCd: [...paymentCodes][0] } : {}),
    salesSttsCd: config.document.salesSttsCd,
    cfmDt: context.cfmDt,
    salesDt: context.salesDt,
    totItemCnt: mappedLines.length,
    ...buckets,
    totTaxblAmt: kraDecimalToNumber(evidence.totTaxblAmt),
    totTaxAmt: kraDecimalToNumber(evidence.totTaxAmt),
    totAmt: kraDecimalToNumber(evidence.totAmt),
    prchrAcptcYn: config.document.prchrAcptcYn,
    regrId: config.taxpayer.regrId,
    regrNm: config.taxpayer.regrNm,
    modrId: config.taxpayer.modrId,
    modrNm: config.taxpayer.modrNm,
    receipt: {
      ...(customerPin ? { custTin: customerPin } : {}),
      prchrAcptcYn: config.document.prchrAcptcYn,
      rcptPbctDt: context.rcptPbctDt,
      ...(config.provider === "vscu" && context.rptNo !== undefined
        ? { rptNo: context.rptNo }
        : {}),
    },
    itemList: mappedLines,
  };
  const candidate: unknown =
    config.provider === "oscu"
      ? { ...common, cmcKey: config.taxpayer.cmcKey }
      : { ...common, salesTyCd: "N" };
  const schema = config.provider === "oscu" ? kraOscuSalesRequestSchema : kraVscuSalesRequestSchema;
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    return {
      success: false,
      stage: "structure",
      errors: parsed.error.issues.map((issue) => ({
        field: `kraSales.${issue.path.map(String).join(".") || "request"}`,
        message: issue.message,
      })),
    };
  }
  const request = deepFreeze(parsed.data);
  const contractIssues = validateKraSalesRequest(request, config.provider);
  if (contractIssues.length > 0) {
    return {
      success: false,
      stage: "structure",
      errors: contractIssues.map((message) => ({ field: "kraSales", message })),
    };
  }
  markKraSalesRequestMapped(request, config.provider);
  return {
    success: true,
    provider: config.provider,
    request,
    configurationId: config.configurationId,
    configurationDigest: digestKraSalesMappingConfiguration(config),
    policyVersion: config.policyVersion,
    snapshotId: input.snapshot.snapshotId,
    allocationReference: context.allocationReference,
    readiness: "structurally_valid_external_acceptance_unverified",
  };
}
