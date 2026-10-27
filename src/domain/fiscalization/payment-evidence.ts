export type PaymentEvidenceState = "unpaid" | "partial" | "full" | "refunded" | "unresolved";

export type PaymentEvidenceUnavailableReason =
  "source-not-integrated" | "missing" | "ambiguous" | "conflicting" | "incomplete";

export interface PaymentEvidenceTransaction {
  readonly amount: string;
  readonly currencyCode: string;
  readonly method: string;
  readonly reference: string | null;
  readonly paidAt: string | null;
}

export type PaymentEvidence =
  | {
      readonly kind: "unavailable";
      readonly reason: PaymentEvidenceUnavailableReason;
    }
  | {
      readonly kind: "reported";
      readonly state: PaymentEvidenceState;
      readonly invoiceAmount: string;
      readonly outstandingBalance: string;
      readonly amountPaid: string;
      readonly currencyCode: string;
      readonly source: {
        readonly system: string;
        readonly recordId: string | null;
      } | null;
      readonly transactions: readonly PaymentEvidenceTransaction[];
    };

export interface PaymentEvidenceAssessment {
  readonly kind: "blocked";
  readonly consistency: "unknown" | "consistent" | "inconsistent";
  readonly issues: readonly PaymentEvidenceIssue[];
}

export type PaymentEvidenceIssue =
  | "evidence_unavailable"
  | "invalid_invoice_amount"
  | "invalid_outstanding_balance"
  | "invalid_amount_paid"
  | "invalid_transaction_amount"
  | "payment_evidence_incomplete"
  | "currency_mismatch"
  | "invoice_mismatch"
  | "amounts_do_not_reconcile"
  | "transactions_do_not_reconcile"
  | "payment_state_conflicts_with_amounts"
  | "payment_state_unresolved"
  | "payment_source_unverified"
  | "payment_method_contract_unverified"
  | "payment_rules_unverified";

interface DecimalValue {
  readonly coefficient: bigint;
  readonly scale: number;
}

function parseNonNegativeDecimal(value: string): DecimalValue | null {
  if (value.length > 64 || !/^\d+(?:\.\d+)?$/.test(value)) {
    return null;
  }

  const [whole = "", fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function addDecimals(left: DecimalValue, right: DecimalValue): DecimalValue {
  const scale = Math.max(left.scale, right.scale);
  return {
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

function decimalsEqual(left: DecimalValue, right: DecimalValue): boolean {
  const scale = Math.max(left.scale, right.scale);
  return (
    left.coefficient * 10n ** BigInt(scale - left.scale) ===
    right.coefficient * 10n ** BigInt(scale - right.scale)
  );
}

function compareDecimals(left: DecimalValue, right: DecimalValue): number {
  const scale = Math.max(left.scale, right.scale);
  const scaledLeft = left.coefficient * 10n ** BigInt(scale - left.scale);
  const scaledRight = right.coefficient * 10n ** BigInt(scale - right.scale);
  return scaledLeft === scaledRight ? 0 : scaledLeft < scaledRight ? -1 : 1;
}

/**
 * Checks consistency only. Even consistent evidence is not authorization:
 * the upstream source, Kenyan payment rules, and device payment contract
 * remain unverified, so every assessment is blocked.
 */
export function assessPaymentEvidence(
  evidence: PaymentEvidence,
  invoice: { readonly total: string; readonly currencyCode: string },
): PaymentEvidenceAssessment {
  if (evidence.kind === "unavailable") {
    return {
      kind: "blocked",
      consistency: "unknown",
      issues: ["evidence_unavailable"],
    };
  }

  const issues: PaymentEvidenceIssue[] = [];
  const invoiceAmount = parseNonNegativeDecimal(evidence.invoiceAmount);
  const expectedInvoiceAmount = parseNonNegativeDecimal(invoice.total);
  const outstandingBalance = parseNonNegativeDecimal(evidence.outstandingBalance);
  const amountPaid = parseNonNegativeDecimal(evidence.amountPaid);

  if (invoiceAmount === null) {
    issues.push("invalid_invoice_amount");
  }
  if (
    expectedInvoiceAmount === null ||
    (invoiceAmount !== null && !decimalsEqual(invoiceAmount, expectedInvoiceAmount)) ||
    evidence.currencyCode.trim().toUpperCase() !== invoice.currencyCode.trim().toUpperCase()
  ) {
    issues.push("invoice_mismatch");
  }
  if (outstandingBalance === null) {
    issues.push("invalid_outstanding_balance");
  }
  if (amountPaid === null) {
    issues.push("invalid_amount_paid");
  }

  issues.push("payment_source_unverified");

  const transactionAmounts: DecimalValue[] = [];
  for (const transaction of evidence.transactions) {
    const amount = parseNonNegativeDecimal(transaction.amount);
    if (amount === null) {
      issues.push("invalid_transaction_amount");
      continue;
    }
    transactionAmounts.push(amount);

    if (
      transaction.currencyCode.trim().toUpperCase() !== evidence.currencyCode.trim().toUpperCase()
    ) {
      issues.push("currency_mismatch");
    }

    if (!transaction.method.trim()) {
      issues.push("payment_method_contract_unverified");
    }
  }

  if (evidence.transactions.length > 0) {
    issues.push("payment_method_contract_unverified");
  }

  if (invoiceAmount !== null && outstandingBalance !== null && amountPaid !== null) {
    if (!decimalsEqual(addDecimals(outstandingBalance, amountPaid), invoiceAmount)) {
      issues.push("amounts_do_not_reconcile");
    }

    const paidComparedToInvoice = compareDecimals(amountPaid, invoiceAmount);
    const outstandingIsZero = outstandingBalance.coefficient === 0n;
    const paidIsZero = amountPaid.coefficient === 0n;
    if (
      (evidence.state === "unpaid" && (!paidIsZero || outstandingIsZero)) ||
      (evidence.state === "partial" &&
        (paidIsZero || outstandingIsZero || paidComparedToInvoice >= 0)) ||
      (evidence.state === "full" && (!outstandingIsZero || paidComparedToInvoice !== 0))
    ) {
      issues.push("payment_state_conflicts_with_amounts");
    }

    if (evidence.transactions.length === 0) {
      if (amountPaid.coefficient !== 0n) {
        issues.push("payment_evidence_incomplete");
      }
    } else if (
      transactionAmounts.length === evidence.transactions.length &&
      !decimalsEqual(
        transactionAmounts.reduce(addDecimals, {
          coefficient: 0n,
          scale: 0,
        }),
        amountPaid,
      )
    ) {
      issues.push("transactions_do_not_reconcile");
    }
  }

  if (
    !/^[A-Za-z]{3}$/.test(evidence.currencyCode) ||
    evidence.transactions.some(
      (transaction) =>
        transaction.currencyCode.trim().toUpperCase() !==
        evidence.currencyCode.trim().toUpperCase(),
    )
  ) {
    issues.push("currency_mismatch");
  }

  if (evidence.state === "refunded" || evidence.state === "unresolved") {
    issues.push("payment_state_unresolved");
  }

  issues.push("payment_rules_unverified");

  const uniqueIssues = [...new Set(issues)];
  return {
    kind: "blocked",
    consistency: uniqueIssues.some((issue) =>
      [
        "invalid_invoice_amount",
        "invalid_outstanding_balance",
        "invalid_amount_paid",
        "invalid_transaction_amount",
        "currency_mismatch",
        "invoice_mismatch",
        "amounts_do_not_reconcile",
        "transactions_do_not_reconcile",
        "payment_state_conflicts_with_amounts",
      ].includes(issue),
    )
      ? "inconsistent"
      : "consistent",
    issues: uniqueIssues,
  };
}
