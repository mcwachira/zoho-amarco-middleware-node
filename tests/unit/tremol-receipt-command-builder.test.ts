import { describe, expect, it } from "vitest";
import {
  buildTremolReceiptCommandPlan,
  type TremolReceiptCustomer,
  type TremolReceiptLine,
} from "../../src/infrastructure/device/tremol-receipt-command-builder.js";

const customer: TremolReceiptCustomer = {
  companyName: "Example Customer Ltd",
  clientPin: "P051234567X",
  headquarters: "Diani",
  address: "Main Road",
  postalCodeAndCity: "80400 Ukunda",
  traderSystemInvoiceNumber: "INV-1001",
};

const line: TremolReceiptLine = {
  name: "Consulting service",
  vatClass: "A",
  price: "100.00",
  unit: "EA",
  hsCode: "1234.56.78",
  hsName: "Consulting",
  vatGroupRate: "0",
  quantity: "1",
};

describe("buildTremolReceiptCommandPlan", () => {
  it("builds a non-executable plan for a valid customer and line", () => {
    const plan = buildTremolReceiptCommandPlan(customer, [line]);

    expect(plan.executable).toBe(false);
    expect(plan.commands).toHaveLength(3);
    expect(plan.commands[0]).toContain("OpenInvoiceWithFreeCustomerData(");
    expect(plan.commands[1]).toContain("SellPLUfromExtDB(");
    expect(plan.commands[2]).toBe("Subtotal()");
  });

  it("preserves the locally constructed SellPLUfromExtDB argument order", () => {
    const plan = buildTremolReceiptCommandPlan(customer, [line]);

    expect(plan.commands[1]).toBe(
      "SellPLUfromExtDB(" +
        "NamePLU=Consulting service," +
        "OptionVATClass=A," +
        "Price=100.00," +
        "MeasureUnit=EA," +
        "HSCode=1234.56.78," +
        "HSName=Consulting," +
        "VATGrRate=0," +
        "Quantity=1" +
        ")",
    );
  });

  it("preserves the locally constructed customer command argument order", () => {
    const plan = buildTremolReceiptCommandPlan(customer, [line]);

    expect(plan.commands[0]).toBe(
      "OpenInvoiceWithFreeCustomerData(" +
        "CompanyName=Example Customer Ltd," +
        "ClientPINnum=P051234567X," +
        "HeadQuarters=Diani," +
        "Address=Main Road," +
        "PostalCodeAndCity=80400 Ukunda," +
        "ExemptionNum=," +
        "TraderSystemInvNum=INV-1001" +
        ")",
    );
  });

  it("rejects an empty list of receipt lines", () => {
    expect(() => buildTremolReceiptCommandPlan(customer, [])).toThrow(
      "At least one receipt line is required.",
    );
  });

  it("includes an empty exemption argument when no exemption number is supplied", () => {
    const plan = buildTremolReceiptCommandPlan(customer, [line]);

    expect(plan.commands[0]).toContain("ExemptionNum=");
    expect(plan.commands[0]).toContain("TraderSystemInvNum=INV-1001");
  });
  it("rejects customer names that exceed the provisional local limit", () => {
    expect(() =>
      buildTremolReceiptCommandPlan({ ...customer, companyName: "C".repeat(31) }, [line]),
    ).toThrow("companyName must not exceed 30 characters.");
  });

  it("rejects unsupported VAT classes instead of guessing", () => {
    expect(() => buildTremolReceiptCommandPlan(customer, [{ ...line, vatClass: "B" }])).toThrow(
      "vatClass is not supported",
    );
  });

  it("rejects command delimiters in customer data", () => {
    expect(() =>
      buildTremolReceiptCommandPlan({ ...customer, companyName: "Example, Ltd" }, [line]),
    ).toThrow("contains a command delimiter");
  });

  it("rejects line names containing newlines", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, name: "Service\nOther" }]),
    ).toThrow("contains unsupported characters");
  });

  it.each([
    ["price", { ...line, price: "abc" }],
    ["vatGroupRate", { ...line, vatGroupRate: "1.2.3" }],
    ["quantity", { ...line, quantity: "one" }],
    ["discountOrAdditionPercent", { ...line, discountOrAdditionPercent: "10%" }],
  ] as const)("rejects malformed decimal input for %s", (field, invalidLine) => {
    expect(() => buildTremolReceiptCommandPlan(customer, [invalidLine])).toThrow(
      `${field} must be a valid decimal number.`,
    );
  });

  it("accepts a price with five decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, price: "12.12345" }]),
    ).not.toThrow();
  });

  it("rejects a price with six decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, price: "12.123456" }]),
    ).toThrow("price must not exceed 5 decimal places.");
  });

  it("accepts a quantity with three decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, quantity: "1.125" }]),
    ).not.toThrow();
  });

  it("rejects a quantity with four decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, quantity: "1.1234" }]),
    ).toThrow("quantity must not exceed 3 decimal places.");
  });

  it("rejects a quantity longer than ten characters", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, quantity: "12345678901" }]),
    ).toThrow("quantity must not exceed 10 characters.");
  });

  it("rejects a discount percentage longer than seven characters", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, discountOrAdditionPercent: "12345678" }]),
    ).toThrow("discountOrAdditionPercent must not exceed 7 characters.");
  });

  it("allows a negative price in decimal validation", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, price: "-12.12345" }]),
    ).not.toThrow();
  });

  it("accepts a VAT rate with five characters and three decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, vatGroupRate: "1.234" }]),
    ).not.toThrow();
  });

  it("accepts a discount percentage with seven characters and four decimal places", () => {
    expect(() =>
      buildTremolReceiptCommandPlan(customer, [{ ...line, discountOrAdditionPercent: "12.3456" }]),
    ).not.toThrow();
  });
});
