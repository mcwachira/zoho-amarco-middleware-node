import { describe, expect, it } from "vitest";

import {
  assessPaymentEvidence,
  type PaymentEvidence,
} from "../../src/domain/fiscalization/payment-evidence.js";

const invoice = { total: "100", currencyCode: "KES" };

function reportedPayment(
  overrides: Partial<Extract<PaymentEvidence, { kind: "reported" }>> = {},
): PaymentEvidence {
  return {
    kind: "reported",
    state: "full",
    invoiceAmount: "100.00",
    outstandingBalance: "0",
    amountPaid: "100",
    currencyCode: "KES",
    source: { system: "synthetic-fixture", recordId: "payment-1" },
    transactions: [],
    ...overrides,
  };
}

describe("assessPaymentEvidence", () => {
  it("represents missing, ambiguous, conflicting, and incomplete evidence as blocked", () => {
    for (const reason of ["missing", "ambiguous", "conflicting", "incomplete"] as const) {
      expect(assessPaymentEvidence({ kind: "unavailable", reason }, invoice)).toEqual({
        kind: "blocked",
        consistency: "unknown",
        issues: ["evidence_unavailable"],
      });
    }
  });

  it.each(["unpaid", "partial", "full", "refunded", "unresolved"] as const)(
    "does not authorize a reported %s payment state while payment rules are unverified",
    (state) => {
      const evidence = reportedPayment({
        state,
        ...(state === "unpaid"
          ? { invoiceAmount: "100", outstandingBalance: "100", amountPaid: "0" }
          : {}),
        ...(state === "partial"
          ? { invoiceAmount: "100", outstandingBalance: "60", amountPaid: "40" }
          : {}),
        ...(state === "refunded"
          ? { invoiceAmount: "100", outstandingBalance: "100", amountPaid: "0" }
          : {}),
      });

      const result = assessPaymentEvidence(evidence, invoice);

      expect(result.kind).toBe("blocked");
      expect(result.issues).toContain("payment_rules_unverified");
      if (state === "refunded" || state === "unresolved") {
        expect(result.issues).toContain("payment_state_unresolved");
      }
    },
  );

  it("preserves exact decimal precision while reconciling invoice and payment values", () => {
    const result = assessPaymentEvidence(
      reportedPayment({
        state: "partial",
        invoiceAmount: "0.30000000000000000001",
        outstandingBalance: "0.1",
        amountPaid: "0.20000000000000000001",
        transactions: [
          {
            amount: "0.20000000000000000001",
            currencyCode: "KES",
            method: "synthetic",
            reference: "synthetic-reference",
            paidAt: null,
          },
        ],
      }),
      { total: "0.30000000000000000001", currencyCode: "KES" },
    );

    expect(result.consistency).toBe("consistent");
    expect(result.issues).toEqual([
      "payment_source_unverified",
      "payment_method_contract_unverified",
      "payment_rules_unverified",
    ]);
  });

  it("detects invoice and payment reconciliation errors", () => {
    const result = assessPaymentEvidence(
      reportedPayment({ invoiceAmount: "100", outstandingBalance: "20", amountPaid: "70" }),
      invoice,
    );

    expect(result.consistency).toBe("inconsistent");
    expect(result.issues).toContain("amounts_do_not_reconcile");
  });

  it("detects inconsistent transaction totals and currencies without inferring a method", () => {
    const result = assessPaymentEvidence(
      reportedPayment({
        transactions: [
          {
            amount: "90",
            currencyCode: "USD",
            method: "unknown-method",
            reference: "synthetic-reference",
            paidAt: null,
          },
        ],
      }),
      invoice,
    );

    expect(result.consistency).toBe("inconsistent");
    expect(result.issues).toContain("transactions_do_not_reconcile");
    expect(result.issues).toContain("currency_mismatch");
    expect(result.issues).toContain("payment_method_contract_unverified");
  });

  it("blocks even a consistent reported payment when its source is missing", () => {
    const result = assessPaymentEvidence(reportedPayment({ source: null }), invoice);

    expect(result.kind).toBe("blocked");
    expect(result.issues).toContain("payment_source_unverified");
  });

  it("does not accept an unknown payment method as supported", () => {
    const result = assessPaymentEvidence(
      reportedPayment({
        transactions: [
          {
            amount: "100",
            currencyCode: "KES",
            method: "unknown-method",
            reference: null,
            paidAt: "2026-10-27T00:00:00.000Z",
          },
        ],
      }),
      invoice,
    );

    expect(result.kind).toBe("blocked");
    expect(result.issues).toContain("payment_method_contract_unverified");
    expect(result.issues).toContain("payment_rules_unverified");
  });

  it("detects conflicts between a declared state and the reported amounts", () => {
    const result = assessPaymentEvidence(
      reportedPayment({
        state: "full",
        invoiceAmount: "100",
        outstandingBalance: "10",
        amountPaid: "90",
      }),
      invoice,
    );

    expect(result.consistency).toBe("inconsistent");
    expect(result.issues).toContain("payment_state_conflicts_with_amounts");
  });

  it("requires the evidence to reconcile with the actual invoice snapshot", () => {
    const result = assessPaymentEvidence(
      reportedPayment({ invoiceAmount: "100", outstandingBalance: "0", amountPaid: "100" }),
      { total: "101", currencyCode: "KES" },
    );

    expect(result.consistency).toBe("inconsistent");
    expect(result.issues).toContain("invoice_mismatch");
  });
});
