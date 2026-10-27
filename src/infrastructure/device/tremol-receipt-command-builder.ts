/**
 * Builds a non-executable receipt-command proposal from unverified assumptions.
 *
 * This module does not execute commands or communicate with the fiscal unit.
 * Payment, receipt closure, VAT mapping, and recovery must be verified before
 * a complete fiscalization transaction can be enabled.
 */

export interface TremolReceiptCustomer {
  readonly companyName: string;
  readonly clientPin: string;
  readonly headquarters: string;
  readonly address: string;
  readonly postalCodeAndCity: string;
  readonly exemptionNumber?: string;
  readonly traderSystemInvoiceNumber: string;
}

export interface TremolReceiptLine {
  readonly name: string;
  readonly vatClass: string;
  readonly price: string;
  readonly unit: string;
  readonly hsCode: string;
  readonly hsName: string;
  readonly vatGroupRate: string;
  readonly quantity: string;
  readonly discountOrAdditionPercent?: string;
}

export interface TremolCommandPlan {
  readonly commands: readonly string[];
  readonly executable: false;
}

/**
 * Applies provisional local field-length checks that are not vendor-verified.
 *
 * Command argument encoding is validated separately because valid text may
 * still contain characters that interfere with the command structure.
 */
function validateText(field: string, value: string, maxLength: number): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }

  if (value.length > maxLength) {
    throw new Error(`${field} must not exceed ${maxLength} characters.`);
  }

  if (/[<>\r\n]/.test(value)) {
    throw new Error(`${field} contains unsupported characters.`);
  }
}

/**
 * Validates decimal syntax and maximum fractional precision.
 *
 * This function deliberately does not impose numeric ranges or rounding.
 * Those rules must follow the verified Kenya CU protocol.
 *
 * Negative values are currently accepted by this local validator only.
 */

function validateDecimal(field: string, value: string, maxFractionDigits?: number): void {
  const match = /^-?\d+(?:\.(\d+))?$/.exec(value);

  if (!match) {
    throw new Error(`${field} must be a valid decimal number.`);
  }

  const fraction = match[1] ?? "";

  if (maxFractionDigits !== undefined && fraction.length > maxFractionDigits) {
    throw new Error(`${field} must not exceed ${maxFractionDigits} decimal places.`);
  }
}

/**
 * Prevents values from altering the structure of a command argument.
 *
 * Until the ZFPLabServer escaping rules for arbitrary text are verified,
 * values containing command delimiters are rejected rather than guessed.
 */
function validateArgumentValue(field: string, value: string): string {
  if (/[(),=\r\n]/.test(value)) {
    throw new Error(`${field} contains a command delimiter; encoding rules must be verified.`);
  }

  return value;
}

function argument(name: string, value: string): string {
  return `${name}=${validateArgumentValue(name, value)}`;
}

/**
 * Builds a receipt command plan without executing it.
 *
 * Only VAT class A is currently accepted by this provisional planner. This
 * does not establish a valid device or Kenyan tax classification.
 */
export function buildTremolReceiptCommandPlan(
  customer: TremolReceiptCustomer,
  lines: readonly TremolReceiptLine[],
): TremolCommandPlan {
  if (lines.length === 0) {
    throw new Error("At least one receipt line is required.");
  }

  // Apply local limits pending authoritative Kenya-specific documentation.
  validateText("companyName", customer.companyName, 30);
  validateText("clientPin", customer.clientPin, 14);
  validateText("headquarters", customer.headquarters, 30);
  validateText("address", customer.address, 30);
  validateText("postalCodeAndCity", customer.postalCodeAndCity, 30);
  validateText("traderSystemInvoiceNumber", customer.traderSystemInvoiceNumber, 15);

  if (customer.exemptionNumber !== undefined) {
    validateText("exemptionNumber", customer.exemptionNumber, 30);
  }

  const openInvoiceArguments = [
    argument("CompanyName", customer.companyName),
    argument("ClientPINnum", customer.clientPin),
    argument("HeadQuarters", customer.headquarters),
    argument("Address", customer.address),
    argument("PostalCodeAndCity", customer.postalCodeAndCity),
    argument("ExemptionNum", customer.exemptionNumber ?? ""),
    argument("TraderSystemInvNum", customer.traderSystemInvoiceNumber),
  ];

  const commands = [`OpenInvoiceWithFreeCustomerData(${openInvoiceArguments.join(",")})`];

  for (const [index, line] of lines.entries()) {
    const field = `lines[${index}]`;

    // Apply local limits pending authoritative Kenya-specific documentation.
    validateText(`${field}.name`, line.name, 36);
    validateText(`${field}.vatClass`, line.vatClass, 1);
    validateText(`${field}.price`, line.price, 15);
    validateText(`${field}.unit`, line.unit, 3);
    validateText(`${field}.hsCode`, line.hsCode, 10);
    validateText(`${field}.hsName`, line.hsName, 20);
    validateText(`${field}.vatGroupRate`, line.vatGroupRate, 5);
    validateText(`${field}.quantity`, line.quantity, 10);

    // Validate decimal syntax and fractional precision.
    validateDecimal(`${field}.price`, line.price, 5);
    validateDecimal(`${field}.vatGroupRate`, line.vatGroupRate);
    validateDecimal(`${field}.quantity`, line.quantity, 3);

    if (line.discountOrAdditionPercent !== undefined) {
      validateText(`${field}.discountOrAdditionPercent`, line.discountOrAdditionPercent, 7);

      validateDecimal(`${field}.discountOrAdditionPercent`, line.discountOrAdditionPercent);
    }

    // Do not infer VAT treatment from the available command catalogue.
    if (line.vatClass !== "A") {
      throw new Error(
        `${field}.vatClass is not supported by the currently verified command catalogue.`,
      );
    }

    const lineArguments = [
      argument("NamePLU", line.name),
      argument("OptionVATClass", line.vatClass),
      argument("Price", line.price),
      argument("MeasureUnit", line.unit),
      argument("HSCode", line.hsCode),
      argument("HSName", line.hsName),
      argument("VATGrRate", line.vatGroupRate),
      argument("Quantity", line.quantity),
    ];

    if (line.discountOrAdditionPercent !== undefined) {
      lineArguments.push(argument("DiscAddP", line.discountOrAdditionPercent));
    }

    commands.push(`SellPLUfromExtDB(${lineArguments.join(",")})`);
  }

  // This is a planned command only. It does not close or finalize a receipt.
  commands.push("Subtotal()");

  return {
    commands,
    executable: false,
  };
}
