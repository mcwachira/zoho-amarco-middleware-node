import type { FiscalInvoiceCandidate } from "../../application/zoho/zoho-invoice-mapper.js";
import {
  buildTremolReceiptCommandPlan,
  type TremolCommandPlan,
  type TremolReceiptCustomer,
  type TremolReceiptLine,
} from "./tremol-receipt-command-builder.js";

export interface FiscalLineMetadata {
  /** Must match a Zoho invoice line ID. */
  readonly sourceLineId: string;
  readonly vatClass: string;
  readonly measureUnit: string;
  readonly hsCode: string;
  readonly hsName: string;
  readonly vatGroupRate: string;
  readonly discountOrAdditionPercent?: string;
}

export interface ZohoTremolMappingInput {
  readonly invoice: FiscalInvoiceCandidate;
  readonly customer: TremolReceiptCustomer;
  readonly lineMetadata: readonly FiscalLineMetadata[];
}

export type ZohoTremolMappingResult =
  | {
      readonly success: true;
      readonly plan: TremolCommandPlan;
    }
  | {
      readonly success: false;
      readonly errors: readonly {
        readonly field: string;
        readonly message: string;
      }[];
    };

/**
 * Maps a validated Zoho invoice candidate to a non-executable Tremol plan.
 *
 * Fiscal metadata must be supplied explicitly. This function does not infer
 * VAT classes, HS codes, units, or Kenyan tax treatment.
 *
 * The plan must not be sent to the device until the vendor command contract,
 * payment sequence, and receipt closure flow have been verified.
 */
export function mapZohoInvoiceToTremolPlan(input: ZohoTremolMappingInput): ZohoTremolMappingResult {
  const { invoice, lineMetadata } = input;
  const errors: { field: string; message: string }[] = [];
  const metadataByLineId = new Map<string, FiscalLineMetadata>();

  for (const [index, metadata] of lineMetadata.entries()) {
    const sourceLineId = metadata.sourceLineId.trim();

    if (sourceLineId === "") {
      errors.push({
        field: `lineMetadata[${index}].sourceLineId`,
        message: "A source invoice line ID is required.",
      });
      continue;
    }

    if (metadataByLineId.has(sourceLineId)) {
      errors.push({
        field: `lineMetadata[${index}].sourceLineId`,
        message: "Duplicate fiscal metadata for this invoice line.",
      });
      continue;
    }

    metadataByLineId.set(sourceLineId, metadata);
  }

  const invoiceLineIds = new Set<string>();

  for (const [index, line] of invoice.lines.entries()) {
    const sourceLineId = line.sourceLineId?.trim();

    if (!sourceLineId) {
      errors.push({
        field: `invoice.lines[${index}].sourceLineId`,
        message: "The Zoho invoice line has no stable line ID.",
      });
      continue;
    }

    if (invoiceLineIds.has(sourceLineId)) {
      errors.push({
        field: `invoice.lines[${index}].sourceLineId`,
        message: "The Zoho invoice contains duplicate line IDs.",
      });
      continue;
    }

    invoiceLineIds.add(sourceLineId);

    if (!metadataByLineId.has(sourceLineId)) {
      errors.push({
        field: `invoice.lines[${index}]`,
        message: "Explicit fiscal metadata is required for this invoice line.",
      });
    }
  }

  for (const [index, metadata] of lineMetadata.entries()) {
    const sourceLineId = metadata.sourceLineId.trim();

    if (sourceLineId && !invoiceLineIds.has(sourceLineId)) {
      errors.push({
        field: `lineMetadata[${index}].sourceLineId`,
        message: "Fiscal metadata refers to a line not present on the invoice.",
      });
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  const lines: TremolReceiptLine[] = [];

  for (const line of invoice.lines) {
    const sourceLineId = line.sourceLineId?.trim();

    // All invoice IDs and their metadata were checked above.
    if (!sourceLineId) {
      continue;
    }

    const metadata = metadataByLineId.get(sourceLineId);

    if (!metadata) {
      continue;
    }

    lines.push({
      name: line.description ?? "",
      vatClass: metadata.vatClass,
      price: line.unitPrice,
      unit: metadata.measureUnit,
      hsCode: metadata.hsCode,
      hsName: metadata.hsName,
      vatGroupRate: metadata.vatGroupRate,
      quantity: line.quantity,
      ...(metadata.discountOrAdditionPercent !== undefined
        ? { discountOrAdditionPercent: metadata.discountOrAdditionPercent }
        : {}),
    });
  }

  try {
    const plan = buildTremolReceiptCommandPlan(input.customer, lines);
    return { success: true, plan };
  } catch (error) {
    return {
      success: false,
      errors: [
        {
          field: "fiscalMetadata",
          message:
            error instanceof Error ? error.message : "The fiscal command plan could not be built.",
        },
      ],
    };
  }
}
