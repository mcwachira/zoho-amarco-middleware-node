import { createHash } from "node:crypto";
import { z } from "zod";

import type { FiscalCustomerProfileRepository } from "./fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "./fiscal-item-profile-repository.js";
import {
  normalizeCustomerProfileData,
  normalizeItemProfileData,
} from "./fiscal-profile-validation.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";
import type { ZohoPayment } from "../../integrations/zoho/books-client.js";
import {
  FISCALIZATION_SNAPSHOT_VERSION,
  type FiscalizationSnapshot,
  type FiscalizationSnapshotCustomer,
  type FiscalizationSnapshotLineProfile,
  type FiscalizationSnapshotPayment,
} from "../../domain/fiscalization/fiscalization-snapshot.js";
import { mapZohoInvoiceToTremolPlan } from "../../infrastructure/device/zoho-tremol-receipt-mapper.js";

interface PaymentsClient {
  getInvoicePayments(
    invoiceId: string,
    signal?: AbortSignal,
    page?: number,
  ): Promise<{ page: number; payments: readonly ZohoPayment[]; hasMore: boolean }>;
}

export type { PaymentsClient };

const decimalString = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const MAX_FISCALIZATION_SNAPSHOT_SIZE = 1_000_000;

function isValidInvoiceDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

const invoiceSchema = z
  .object({
    zohoInvoiceId: z.string().min(1),
    invoiceNumber: z.string().nullable(),
    customerId: z.string().nullable(),
    customerName: z.string().nullable(),
    currencyCode: z.string().min(1),
    lines: z
      .array(
        z
          .object({
            sourceLineId: z.string().nullable(),
            itemId: z.string().nullable(),
            description: z.string().nullable(),
            quantity: decimalString,
            unitPrice: decimalString,
            lineTotal: decimalString,
            taxId: z.string().nullable(),
            taxName: z.string().nullable(),
            taxType: z.string().nullable(),
            taxPercentage: decimalString.nullable(),
            discountAmount: decimalString.nullable().optional(),
          })
          .strict(),
      )
      .min(1),
    invoiceDate: z
      .string()
      .refine(isValidInvoiceDate, "Must be a valid YYYY-MM-DD invoice date")
      .nullable()
      .optional(),
    discount: z
      .union([decimalString, z.string().regex(/^\d+(?:\.\d+)?%$/)])
      .nullable()
      .optional(),
    discountBeforeTax: z.boolean().nullable().optional(),
    subtotal: decimalString,
    taxTotal: decimalString,
    total: decimalString,
  })
  .strict();

const customerSchema = z
  .object({
    zohoCustomerId: z.string().min(1),
    companyName: z.string().min(1),
    clientPin: z.string().min(1),
    headquarters: z.string().min(1),
    address: z.string().min(1),
    postalCodeAndCity: z.string().min(1),
    exemptionNumber: z.string().nullable(),
    traderSystemInvoiceNumber: z.string().min(1),
  })
  .strict();

const lineProfileSchema = z
  .object({
    sourceLineId: z.string().min(1),
    zohoItemId: z.string().min(1),
    measureUnit: z.string().min(1),
    hsCode: z.string().min(1),
    hsName: z.string().min(1),
    vatClass: z.string().min(1),
    vatGroupRate: decimalString,
  })
  .strict();

const paymentSchema = z
  .object({
    paymentId: z.string().min(1),
    paymentNumber: z.string().nullable(),
    paymentMode: z.string().nullable(),
    amount: decimalString,
    date: z.string().nullable(),
    referenceNumber: z.string().nullable(),
    description: z.string().nullable(),
    source: z.record(z.string(), z.unknown()).readonly(),
  })
  .strict();

interface FiscalizationSnapshotPayload {
  readonly schemaVersion: typeof FISCALIZATION_SNAPSHOT_VERSION;
  readonly registeredAt: string;
  readonly zohoOrganizationId: string;
  readonly invoice: FiscalInvoiceCandidate;
  readonly customer: FiscalizationSnapshotCustomer;
  readonly lineProfiles: readonly FiscalizationSnapshotLineProfile[];
  readonly payments?: readonly FiscalizationSnapshotPayment[] | undefined;
}

export type FiscalizationSnapshotBuildResult =
  | {
      readonly success: true;
      readonly snapshot: FiscalizationSnapshot;
    }
  | {
      readonly success: false;
      readonly errors: readonly { readonly field: string; readonly message: string }[];
    };

export class FiscalizationSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FiscalizationSnapshotError";
  }
}

export class UnsupportedFiscalizationSnapshotVersionError extends FiscalizationSnapshotError {
  constructor(version: number) {
    super(`Fiscalization snapshot version ${version} is not supported.`);
    this.name = "UnsupportedFiscalizationSnapshotVersionError";
  }
}

export class FiscalizationSnapshotMissingError extends FiscalizationSnapshotError {
  constructor() {
    super("This legacy fiscalization request has no snapshot and requires operator review.");
    this.name = "FiscalizationSnapshotMissingError";
  }
}

function snapshotDigest(payload: FiscalizationSnapshotPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function serializeSnapshot(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new FiscalizationSnapshotError("The stored fiscalization snapshot is not valid JSON.");
  }
  if (serialized === undefined) {
    throw new FiscalizationSnapshotError("The stored fiscalization snapshot is not valid JSON.");
  }
  return serialized;
}

function freezeSnapshot<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      freezeSnapshot(nested);
    }
  }
  return value;
}

function validationError(field: string, message: string): FiscalizationSnapshotBuildResult {
  return { success: false, errors: [{ field, message }] };
}

export async function buildFiscalizationSnapshot(input: {
  readonly invoice: FiscalInvoiceCandidate;
  readonly zohoOrganizationId: string;
  readonly customerProfiles: Pick<FiscalCustomerProfileRepository, "findByZohoCustomerId">;
  readonly itemProfiles: Pick<FiscalItemProfileRepository, "findByZohoItemId">;
  readonly paymentsClient?: Pick<PaymentsClient, "getInvoicePayments">;
  readonly registeredAt?: Date;
  readonly signal?: AbortSignal | undefined;
}): Promise<FiscalizationSnapshotBuildResult> {
  const parsedInvoice = invoiceSchema.safeParse(input.invoice);
  if (!parsedInvoice.success) {
    return {
      success: false,
      errors: parsedInvoice.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "invoice",
        message: issue.message,
      })),
    };
  }

  const organizationId = input.zohoOrganizationId.trim();
  if (!organizationId) {
    return validationError("zohoOrganizationId", "A configured Zoho organization ID is required.");
  }

  const invoice = parsedInvoice.data;
  if (invoice.currencyCode !== "KES") {
    return validationError(
      "currencyCode",
      "Only KES invoices are supported by the current receipt-planning workflow.",
    );
  }

  const customerId = invoice.customerId?.trim();
  if (!customerId) {
    return validationError("customerId", "The Zoho invoice has no customer ID.");
  }

  const profile = await input.customerProfiles.findByZohoCustomerId(customerId);
  if (!profile) {
    return validationError("customer", "No fiscal profile is configured for this Zoho customer.");
  }
  if (profile.zohoCustomerId !== customerId) {
    return validationError(
      "customer",
      "The fiscal customer profile does not match the invoice customer.",
    );
  }

  let customerData: ReturnType<typeof normalizeCustomerProfileData>;
  try {
    customerData = normalizeCustomerProfileData(profile);
  } catch (error: unknown) {
    return validationError(
      "customer",
      error instanceof Error ? error.message : "The fiscal customer profile is invalid.",
    );
  }

  const lineProfiles: FiscalizationSnapshotLineProfile[] = [];
  const lineMetadata: {
    sourceLineId: string;
    vatClass: string;
    measureUnit: string;
    hsCode: string;
    hsName: string;
    vatGroupRate: string;
  }[] = [];
  const seenLineIds = new Set<string>();

  for (const [index, line] of invoice.lines.entries()) {
    const sourceLineId = line.sourceLineId?.trim();
    const itemId = line.itemId?.trim();

    if (!sourceLineId) {
      return validationError(
        `invoice.lines[${index}].sourceLineId`,
        "A stable invoice line ID is required.",
      );
    }
    if (seenLineIds.has(sourceLineId)) {
      return validationError(
        `invoice.lines[${index}].sourceLineId`,
        "Invoice line IDs must be unique.",
      );
    }
    seenLineIds.add(sourceLineId);

    if (!itemId) {
      return validationError(
        `invoice.lines[${index}].itemId`,
        "The invoice line has no Zoho item ID.",
      );
    }

    const itemProfile = await input.itemProfiles.findByZohoItemId(itemId);
    if (!itemProfile) {
      return validationError(
        `invoice.lines[${index}].itemId`,
        "No fiscal profile is configured for this Zoho item.",
      );
    }
    if (itemProfile.zohoItemId !== itemId) {
      return validationError(
        `invoice.lines[${index}].itemId`,
        "The fiscal item profile does not match the invoice item.",
      );
    }

    let itemData: ReturnType<typeof normalizeItemProfileData>;
    try {
      itemData = normalizeItemProfileData(itemProfile);
    } catch (error: unknown) {
      return validationError(
        `invoice.lines[${index}].itemId`,
        error instanceof Error ? error.message : "The fiscal item profile is invalid.",
      );
    }

    lineProfiles.push({
      sourceLineId,
      zohoItemId: itemId,
      ...itemData,
    });
    lineMetadata.push({
      sourceLineId,
      vatClass: itemData.vatClass,
      measureUnit: itemData.measureUnit,
      hsCode: itemData.hsCode,
      hsName: itemData.hsName,
      vatGroupRate: itemData.vatGroupRate,
    });
  }

  const customer: FiscalizationSnapshotCustomer = {
    zohoCustomerId: customerId,
    ...customerData,
    traderSystemInvoiceNumber: invoice.invoiceNumber ?? invoice.zohoInvoiceId,
  };
  const planValidation = mapZohoInvoiceToTremolPlan({
    invoice,
    customer: {
      companyName: customer.companyName,
      clientPin: customer.clientPin,
      headquarters: customer.headquarters,
      address: customer.address,
      postalCodeAndCity: customer.postalCodeAndCity,
      ...(customer.exemptionNumber !== null ? { exemptionNumber: customer.exemptionNumber } : {}),
      traderSystemInvoiceNumber: customer.traderSystemInvoiceNumber,
    },
    lineMetadata,
  });
  if (!planValidation.success) {
    return { success: false, errors: planValidation.errors };
  }

  const registeredAt = input.registeredAt ?? new Date();
  if (Number.isNaN(registeredAt.getTime())) {
    return validationError("registeredAt", "Registration timestamp must be valid.");
  }

  const payments: FiscalizationSnapshotPayment[] = [];
  if (input.paymentsClient && input.invoice.zohoInvoiceId) {
    try {
      const seenPaymentIds = new Set<string>();
      let page = 1;
      for (;;) {
        input.signal?.throwIfAborted();
        const result = await input.paymentsClient.getInvoicePayments(
          input.invoice.zohoInvoiceId,
          input.signal,
          page,
        );
        input.signal?.throwIfAborted();
        if (result.page !== page) {
          return validationError("payments", "Payment retrieval returned an unexpected page.");
        }
        for (const payment of result.payments) {
          if (seenPaymentIds.has(payment.paymentId)) {
            return validationError("payments", "Payment retrieval returned a duplicate payment.");
          }
          seenPaymentIds.add(payment.paymentId);
          payments.push({
            paymentId: payment.paymentId,
            paymentNumber: payment.paymentNumber,
            paymentMode: payment.paymentMode,
            amount: payment.amount,
            date: payment.date,
            referenceNumber: payment.referenceNumber,
            description: payment.description,
            // Retain a stable provenance digest without persisting the full
            // untrusted provider object, which can contain unrelated personal
            // or payment data.
            source: {
              responseSha256: createHash("sha256")
                .update(JSON.stringify(payment.source))
                .digest("hex"),
            },
          });
        }
        if (!result.hasMore) break;
        if (page >= 100) {
          return validationError(
            "payments",
            "Payment history exceeds the supported pagination limit.",
          );
        }
        page += 1;
      }
    } catch {
      if (input.signal?.aborted) throw input.signal.reason;
      return validationError(
        "payments",
        "Zoho payment evidence could not be retrieved; the fiscalization request was not registered.",
      );
    }
  }

  const payload: FiscalizationSnapshotPayload = {
    schemaVersion: FISCALIZATION_SNAPSHOT_VERSION,
    registeredAt: registeredAt.toISOString(),
    zohoOrganizationId: organizationId,
    invoice,
    customer,
    lineProfiles,
    payments,
  };

  const snapshot = freezeSnapshot({
    ...payload,
    snapshotId: snapshotDigest(payload),
  });

  if (serializeSnapshot(snapshot).length > MAX_FISCALIZATION_SNAPSHOT_SIZE) {
    return validationError(
      "snapshot",
      "Fiscalization snapshot exceeds the supported storage size.",
    );
  }

  return { success: true, snapshot };
}

export function parseFiscalizationSnapshot(
  value: unknown,
  storedVersion: number | null,
): FiscalizationSnapshot {
  if (value === null || value === undefined) {
    throw new FiscalizationSnapshotMissingError();
  }

  if (serializeSnapshot(value).length > MAX_FISCALIZATION_SNAPSHOT_SIZE) {
    throw new FiscalizationSnapshotError(
      "The stored fiscalization snapshot exceeds the supported storage size.",
    );
  }

  const parsed = z
    .object({
      schemaVersion: z.number().int(),
      snapshotId: z.string().regex(/^[0-9a-f]{64}$/),
      registeredAt: z.string().datetime(),
      zohoOrganizationId: z.string().min(1),
      invoice: invoiceSchema,
      customer: customerSchema,
      lineProfiles: z.array(lineProfileSchema).min(1),
      payments: z.array(paymentSchema).optional(),
    })
    .strict()
    .safeParse(value);

  if (!parsed.success) {
    throw new FiscalizationSnapshotError("The stored fiscalization snapshot is malformed.");
  }

  if (parsed.data.schemaVersion !== FISCALIZATION_SNAPSHOT_VERSION) {
    throw new UnsupportedFiscalizationSnapshotVersionError(parsed.data.schemaVersion);
  }
  if (storedVersion !== parsed.data.schemaVersion) {
    throw new FiscalizationSnapshotError(
      "Stored fiscalization snapshot version metadata does not match.",
    );
  }
  if (parsed.data.invoice.zohoInvoiceId.trim() === "") {
    throw new FiscalizationSnapshotError("The stored snapshot has no invoice identity.");
  }
  if (!parsed.data.zohoOrganizationId.trim()) {
    throw new FiscalizationSnapshotError("The stored snapshot has no Zoho organization identity.");
  }
  if (parsed.data.customer.zohoCustomerId !== parsed.data.invoice.customerId) {
    throw new FiscalizationSnapshotError(
      "The stored snapshot customer does not match its invoice.",
    );
  }

  const invoiceLines = new Map<string, string | null>();
  for (const line of parsed.data.invoice.lines) {
    const sourceLineId = line.sourceLineId?.trim();
    if (!sourceLineId || invoiceLines.has(sourceLineId)) {
      throw new FiscalizationSnapshotError("The stored invoice contains invalid line identities.");
    }
    invoiceLines.set(sourceLineId, line.itemId);
  }

  if (
    parsed.data.lineProfiles.length !== invoiceLines.size ||
    parsed.data.lineProfiles.some(
      (profile) => invoiceLines.get(profile.sourceLineId) !== profile.zohoItemId,
    )
  ) {
    throw new FiscalizationSnapshotError("The stored line profiles do not match the invoice.");
  }

  // Validate payments if present
  if (parsed.data.payments) {
    for (const payment of parsed.data.payments) {
      if (payment.paymentId.trim() === "") {
        throw new FiscalizationSnapshotError("A payment in the snapshot has no payment ID.");
      }
    }
  }

  const receiptPlanValidation = mapZohoInvoiceToTremolPlan({
    invoice: parsed.data.invoice,
    customer: {
      companyName: parsed.data.customer.companyName,
      clientPin: parsed.data.customer.clientPin,
      headquarters: parsed.data.customer.headquarters,
      address: parsed.data.customer.address,
      postalCodeAndCity: parsed.data.customer.postalCodeAndCity,
      ...(parsed.data.customer.exemptionNumber !== null
        ? { exemptionNumber: parsed.data.customer.exemptionNumber }
        : {}),
      traderSystemInvoiceNumber: parsed.data.customer.traderSystemInvoiceNumber,
    },
    lineMetadata: parsed.data.lineProfiles,
  });
  if (!receiptPlanValidation.success) {
    throw new FiscalizationSnapshotError(
      "The stored snapshot does not pass fiscal input validation.",
    );
  }

  const { snapshotId, ...parsedPayload } = parsed.data;
  const payload: FiscalizationSnapshotPayload = {
    ...parsedPayload,
    schemaVersion: FISCALIZATION_SNAPSHOT_VERSION,
  };
  if (snapshotDigest(payload) !== snapshotId) {
    throw new FiscalizationSnapshotError(
      "The stored fiscalization snapshot integrity check failed.",
    );
  }

  const lineIds = new Set(parsed.data.lineProfiles.map((line) => line.sourceLineId));
  if (lineIds.size !== parsed.data.lineProfiles.length) {
    throw new FiscalizationSnapshotError(
      "The stored snapshot contains duplicate line profile identities.",
    );
  }

  return freezeSnapshot(parsed.data as FiscalizationSnapshot);
}
