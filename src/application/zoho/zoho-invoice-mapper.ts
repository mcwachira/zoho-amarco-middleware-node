import { z } from "zod";
import type { ZohoInvoice } from "../../integrations/zoho/books-client.js";

/**
 * Zoho may represent monetary values and quantities as JSON numbers.
 * Accept finite numbers or decimal strings, but reject booleans, null,
 * empty strings, NaN, and Infinity.
 *
 * The mapper does not calculate totals or apply tax rules.
 */
const decimalValueSchema = z
  .union([
    z
      .number()
      .finite()
      .transform((value) => String(value)),
    z
      .string()
      .trim()
      .regex(/^-?\d+(?:\.\d+)?$/, "Must be a valid decimal value"),
  ])
  .pipe(z.string());

const optionalTextSchema = z.string().nullable().optional();

const invoiceLineSchema = z.object({
  line_item_id: optionalTextSchema,
  item_id: optionalTextSchema,
  name: optionalTextSchema,
  description: optionalTextSchema,
  quantity: decimalValueSchema,
  rate: decimalValueSchema,
  item_total: decimalValueSchema,
  // Preserve tax metadata for later, verified fiscal mapping.
  tax_id: optionalTextSchema,
  tax_name: optionalTextSchema,
  tax_type: optionalTextSchema,
  tax_percentage: decimalValueSchema.nullable().optional(),
});

const invoiceSourceSchema = z.object({
  invoice_id: z.string().trim().min(1),
  currency_code: z.string().trim().min(1),
  line_items: z.array(invoiceLineSchema).min(1),
  sub_total: decimalValueSchema,
  tax_total: decimalValueSchema,
  total: decimalValueSchema,
});

/**
 * A validated candidate derived from a Zoho Books invoice.
 *
 * This is not a fiscal-device payload and does not indicate that the
 * invoice complies with Kenyan tax or eTIMS requirements.
 */
export interface FiscalInvoiceCandidate {
  readonly zohoInvoiceId: string;
  readonly invoiceNumber: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly currencyCode: string;
  readonly lines: readonly {
    readonly sourceLineId: string | null;
    readonly itemId: string | null;
    readonly description: string | null;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly lineTotal: string;
    readonly taxId: string | null;
    readonly taxName: string | null;
    readonly taxType: string | null;
    readonly taxPercentage: string | null;
  }[];
  readonly subtotal: string;
  readonly taxTotal: string;
  readonly total: string;
}

export type InvoiceMappingResult =
  | {
      readonly success: true;
      readonly candidate: FiscalInvoiceCandidate;
    }
  | {
      readonly success: false;
      readonly errors: readonly {
        readonly field: string;
        readonly message: string;
      }[];
    };

/**
 * Validates the fields needed for an initial invoice candidate.
 *
 * No device commands, database writes, tax calculations, or fiscal
 * receipt issuance occur in this function.
 */
export function mapZohoInvoice(invoice: ZohoInvoice): InvoiceMappingResult {
  const parsed = invoiceSourceSchema.safeParse(invoice.source);

  if (!parsed.success) {
    return {
      success: false,
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.map(String).join(".") || "invoice",
        message: issue.message,
      })),
    };
  }

  const source = parsed.data;

  if (source.invoice_id !== invoice.invoiceId) {
    return {
      success: false,
      errors: [
        {
          field: "invoice_id",
          message: "The source invoice ID does not match the retrieved invoice ID.",
        },
      ],
    };
  }

  // The client extracts this field from the same Zoho invoice response.
  // Reject contradictory or missing top-level currency metadata instead
  // of silently accepting two different currency values.
  const retrievedCurrencyCode = invoice.currencyCode?.trim() ?? "";

  if (retrievedCurrencyCode !== source.currency_code) {
    return {
      success: false,
      errors: [
        {
          field: "currency_code",
          message:
            "The currency code from retrieved invoice metadata does not match the invoice source currency code.",
        },
      ],
    };
  }

  return {
    success: true,
    candidate: {
      zohoInvoiceId: source.invoice_id,
      invoiceNumber: invoice.invoiceNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      currencyCode: source.currency_code,
      lines: source.line_items.map((line) => ({
        sourceLineId: line.line_item_id ?? null,
        itemId: line.item_id ?? null,
        description: line.description ?? line.name ?? null,
        quantity: line.quantity,
        unitPrice: line.rate,
        lineTotal: line.item_total,
        taxId: line.tax_id ?? null,
        taxName: line.tax_name ?? null,
        taxType: line.tax_type ?? null,
        taxPercentage: line.tax_percentage ?? null,
      })),
      subtotal: source.sub_total,
      taxTotal: source.tax_total,
      total: source.total,
    },
  };
}
