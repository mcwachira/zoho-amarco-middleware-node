import { z } from "zod";
import type { ZohoInvoice } from "../../integrations/zoho/books-client.js";

function numberToDecimalString(value: number): string {
  const source = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(source);
  if (!match) return source;

  const [, sign = "", whole = "0", fraction = "", exponentText = "0"] = match;
  const digits = `${whole}${fraction}`;
  const decimalPosition = whole.length + Number(exponentText);
  if (decimalPosition <= 0) {
    return `${sign}0.${"0".repeat(-decimalPosition)}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

/**
 * Zoho may represent monetary values and quantities as JSON numbers.
 * Accept finite numbers or decimal strings, but reject booleans, null,
 * empty strings, NaN, and Infinity.
 *
 * The mapper does not calculate totals or apply tax rules.
 */
const decimalValueSchema = z
  .union([
    z.number().finite().transform(numberToDecimalString),
    z
      .string()
      .trim()
      .regex(/^-?\d+(?:\.\d+)?$/, "Must be a valid decimal value"),
  ])
  .pipe(z.string());

const optionalTextSchema = z.string().nullable().optional();
const discountSchema = z.union([
  decimalValueSchema,
  z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?%$/),
]);

const invoiceLineSchema = z.object({
  line_item_id: optionalTextSchema,
  item_id: optionalTextSchema,
  name: optionalTextSchema,
  description: optionalTextSchema,
  quantity: decimalValueSchema,
  rate: decimalValueSchema,
  item_total: decimalValueSchema,
  discount_amount: decimalValueSchema.nullable().optional(),
  // Preserve tax metadata for later, verified fiscal mapping.
  tax_id: optionalTextSchema,
  tax_name: optionalTextSchema,
  tax_type: optionalTextSchema,
  tax_percentage: decimalValueSchema.nullable().optional(),
});

const invoiceSourceSchema = z.object({
  invoice_id: z.string().trim().min(1),
  date: z.string().trim().nullable().optional(),
  currency_code: z.string().trim().min(1),
  line_items: z.array(invoiceLineSchema).min(1),
  sub_total: decimalValueSchema,
  tax_total: decimalValueSchema,
  total: decimalValueSchema,
  discount: discountSchema.nullable().optional(),
  is_discount_before_tax: z.boolean().nullable().optional(),
});

interface DecimalParts {
  readonly coefficient: bigint;
  readonly scale: number;
}

function decimalParts(value: string): DecimalParts {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const coefficient = BigInt(`${whole}${fraction}` || "0");
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

function decimalSumEquals(left: string, right: string, total: string): boolean {
  const values = [decimalParts(left), decimalParts(right), decimalParts(total)];
  const scale = Math.max(...values.map((value) => value.scale));
  const [leftValue, rightValue, totalValue] = values.map(
    ({ coefficient, scale: valueScale }) => coefficient * 10n ** BigInt(scale - valueScale),
  );
  return (
    leftValue !== undefined && rightValue !== undefined && leftValue + rightValue === totalValue
  );
}

function decimalIsNegative(value: string): boolean {
  return decimalParts(value).coefficient < 0n;
}

function decimalIsPositive(value: string): boolean {
  return decimalParts(value).coefficient > 0n;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

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
    readonly discountAmount?: string | null | undefined;
  }[];
  readonly invoiceDate?: string | null | undefined;
  readonly discount?: string | null | undefined;
  readonly discountBeforeTax?: boolean | null | undefined;
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
  const invoiceStatus = invoice.source["status"];
  const explicitlyVoided =
    invoice.source["is_void"] === true ||
    (typeof invoiceStatus === "string" && invoiceStatus.trim().toLowerCase() === "void");
  if (explicitlyVoided) {
    return {
      success: false,
      errors: [
        {
          field: "status",
          message: "A Zoho invoice explicitly marked void cannot be prepared for fiscalization.",
        },
      ],
    };
  }

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

  if (source.date != null && !isValidIsoDate(source.date)) {
    return {
      success: false,
      errors: [{ field: "date", message: "Zoho invoice date must be a valid YYYY-MM-DD date." }],
    };
  }

  const discountAmount = source.discount?.endsWith("%")
    ? source.discount.slice(0, -1)
    : source.discount;
  if (discountAmount != null && decimalIsNegative(discountAmount)) {
    return {
      success: false,
      errors: [{ field: "discount", message: "Zoho invoice discount cannot be negative." }],
    };
  }

  const invalidLineIndex = source.line_items.findIndex(
    (line) =>
      !decimalIsPositive(line.quantity) ||
      decimalIsNegative(line.rate) ||
      decimalIsNegative(line.item_total) ||
      (line.discount_amount != null && decimalIsNegative(line.discount_amount)) ||
      (line.tax_percentage != null && decimalIsNegative(line.tax_percentage)),
  );
  if (invalidLineIndex >= 0) {
    return {
      success: false,
      errors: [
        {
          field: `line_items.${invalidLineIndex}`,
          message:
            "Invoice line quantity must be positive; price, total, discount, and tax rate must be non-negative.",
        },
      ],
    };
  }

  if (
    decimalIsNegative(source.sub_total) ||
    decimalIsNegative(source.tax_total) ||
    decimalIsNegative(source.total)
  ) {
    return {
      success: false,
      errors: [
        { field: "total", message: "Invoice subtotal, tax total, and total must be non-negative." },
      ],
    };
  }

  // Compare the provider's aggregate amounts exactly. This verifies only the
  // source invoice's own subtotal/tax/total consistency; it does not calculate
  // tax, apply discounts, or establish a KRA rounding rule.
  if (!decimalSumEquals(source.sub_total, source.tax_total, source.total)) {
    return {
      success: false,
      errors: [
        {
          field: "total",
          message:
            "Zoho invoice total does not equal its subtotal plus tax total. Review the source invoice amounts before fiscal preparation.",
        },
      ],
    };
  }

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
        ...(line.discount_amount !== undefined ? { discountAmount: line.discount_amount } : {}),
      })),
      ...(source.date !== undefined ? { invoiceDate: source.date } : {}),
      ...(source.discount !== undefined ? { discount: source.discount } : {}),
      ...(source.is_discount_before_tax !== undefined
        ? { discountBeforeTax: source.is_discount_before_tax }
        : {}),
      subtotal: source.sub_total,
      taxTotal: source.tax_total,
      total: source.total,
    },
  };
}
