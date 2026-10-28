import { describe, expect, it } from "vitest";
import {
  toDatabaseRecord,
  toDomainRecord,
  type FiscalizationRecordRow,
} from "../../src/infrastructure/database/fiscalization-record-mapper.js";

import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import {
  markOutcomeUnknown,
  startFiscalization,
} from "../../src/domain/fiscalization/fiscalization-operations.js";
import { makeFiscalizationSnapshot } from "./fiscalization-snapshot-fixture.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";

const now = new Date("2026-10-23T07:00:00.000Z");
const invoice: FiscalInvoiceCandidate = {
  zohoInvoiceId: "zoho-invoice-1",
  invoiceNumber: "INV-001",
  customerId: "customer-1",
  customerName: "Example Customer",
  currencyCode: "KES",
  lines: [
    {
      sourceLineId: "line-1",
      itemId: "item-1",
      description: "Test product",
      quantity: "1",
      unitPrice: "10.10",
      lineTotal: "10.10",
      taxId: "tax-1",
      taxName: "Source tax",
      taxType: "tax",
      taxPercentage: "16",
    },
  ],
  subtotal: "10.10",
  taxTotal: "1.616",
  total: "11.716",
};
const snapshot = await makeFiscalizationSnapshot(invoice);

function makeRow(overrides: Partial<FiscalizationRecordRow> = {}): FiscalizationRecordRow {
  return {
    id: "fiscalization-1",
    zohoInvoiceId: "zoho-invoice-1",
    status: "Pending",
    snapshotVersion: null,
    snapshotJson: null,
    receiptNumber: null,
    issuedAt: null,
    failureCode: null,
    failureMessage: null,
    outcomeUnknownReason: null,
    outcomeProvenance: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Fiscalization record mapper", () => {
  it("maps a pending database row to a domain record", () => {
    const result = toDomainRecord(makeRow());

    expect(result.id).toBe("fiscalization-1");
    expect(result.status).toBe("Pending");
    expect(result.receipt).toBeNull();
    expect(result.failure).toBeNull();
  });

  it("round-trips an immutable snapshot through database columns", () => {
    const record = createFiscalizationRecord(
      { id: "fiscalization-1", zohoInvoiceId: invoice.zohoInvoiceId, snapshot },
      now,
    );
    const columns = toDatabaseRecord(record);

    expect(columns.snapshotVersion).toBe(snapshot.schemaVersion);
    expect(JSON.parse(columns.snapshotJson ?? "null")).toEqual(snapshot);
    expect(
      toDomainRecord(
        makeRow({
          snapshotVersion: snapshot.schemaVersion,
          snapshotJson: columns.snapshotJson,
        }),
      ).snapshot,
    ).toEqual(snapshot);
  });

  it("fails closed for malformed and unsupported persisted snapshots", () => {
    expect(() => toDomainRecord(makeRow({ snapshotVersion: 1, snapshotJson: "{invalid" }))).toThrow(
      "malformed snapshot JSON",
    );

    const unsupported = { ...snapshot, schemaVersion: 2 };
    expect(() =>
      toDomainRecord({
        ...makeRow(),
        snapshotVersion: 2,
        snapshotJson: JSON.stringify(unsupported),
      }),
    ).toThrow("not supported");
  });

  it("maps receipt information correctly", () => {
    const result = toDomainRecord(
      makeRow({
        status: "Succeeded",
        receiptNumber: "0001234",
        issuedAt: now,
      }),
    );

    expect(result.receipt).toEqual({
      receiptNumber: "0001234",
      issuedAt: now,
    });
  });

  it("maps failure information correctly", () => {
    const result = toDomainRecord(
      makeRow({
        status: "Failed",
        failureCode: "DEVICE_ERROR",
        failureMessage: "The device rejected the operation.",
      }),
    );

    expect(result.failure).toEqual({
      code: "DEVICE_ERROR",
      message: "The device rejected the operation.",
    });
  });

  it("rejects an unknown status from the database", () => {
    expect(() => toDomainRecord(makeRow({ status: "SomethingUnexpected" }))).toThrow(
      "Invalid fiscalization status",
    );
  });

  it("rejects incomplete receipt information", () => {
    expect(() => toDomainRecord(makeRow({ receiptNumber: "0001234" }))).toThrow(
      "incomplete receipt information",
    );
  });

  it("rejects incomplete failure information", () => {
    expect(() => toDomainRecord(makeRow({ failureCode: "DEVICE_ERROR" }))).toThrow(
      "incomplete failure information",
    );
  });

  it("rejects a pending record that contains receipt information", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "Pending",
          receiptNumber: "0001234",
          issuedAt: now,
        }),
      ),
    ).toThrow('Database record in "Pending" status contains outcome data.');
  });

  it("rejects a succeeded record without receipt information", () => {
    expect(() => toDomainRecord(makeRow({ status: "Succeeded" }))).toThrow(
      "Succeeded database record contains inconsistent outcome data.",
    );
  });

  it("rejects a failed record without failure information", () => {
    expect(() => toDomainRecord(makeRow({ status: "Failed" }))).toThrow(
      "Failed database record contains inconsistent outcome data.",
    );
  });

  it("rejects an unknown outcome without a reason", () => {
    expect(() => toDomainRecord(makeRow({ status: "OutcomeUnknown" }))).toThrow(
      "OutcomeUnknown database record contains inconsistent outcome data.",
    );
  });

  it("rejects an unknown outcome with a blank reason", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "OutcomeUnknown",
          outcomeUnknownReason: "   ",
        }),
      ),
    ).toThrow("OutcomeUnknown database record contains inconsistent outcome data.");
  });

  it("maps a domain record back to database columns", () => {
    const pending = createFiscalizationRecord(
      {
        id: "fiscalization-1",
        zohoInvoiceId: "zoho-invoice-1",
      },
      now,
    );

    const result = toDatabaseRecord(pending);

    expect(result).toMatchObject({
      id: "fiscalization-1",
      zohoInvoiceId: "zoho-invoice-1",
      status: "Pending",
      receiptNumber: null,
      issuedAt: null,
      failureCode: null,
      failureMessage: null,
      outcomeUnknownReason: null,
    });
  });

  it("preserves an unknown outcome when mapping to database columns", () => {
    const pending = createFiscalizationRecord({
      id: "fiscalization-1",
      zohoInvoiceId: "zoho-invoice-1",
    });

    const inProgress = startFiscalization(pending);

    const unknown = markOutcomeUnknown(inProgress, "The device response could not be confirmed.");

    const result = toDatabaseRecord(unknown);

    expect(result.status).toBe("OutcomeUnknown");
    expect(result.outcomeUnknownReason).toBe("The device response could not be confirmed.");
  });

  it("rejects an in-progress record that contains an unknown outcome reason", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "InProgress",
          outcomeUnknownReason: "Device response is uncertain.",
        }),
      ),
    ).toThrow('Database record in "InProgress" status contains outcome data.');
  });

  it("rejects a succeeded record that also contains failure information", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "Succeeded",
          receiptNumber: "0001234",
          issuedAt: now,
          failureCode: "DEVICE_ERROR",
          failureMessage: "Conflicting failure information.",
        }),
      ),
    ).toThrow("Succeeded database record contains inconsistent outcome data.");
  });

  it("rejects a failed record that also contains receipt information", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "Failed",
          receiptNumber: "0001234",
          issuedAt: now,
          failureCode: "DEVICE_ERROR",
          failureMessage: "The device rejected the operation.",
        }),
      ),
    ).toThrow("Failed database record contains inconsistent outcome data.");
  });

  it("rejects an unknown outcome that also contains receipt information", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "OutcomeUnknown",
          receiptNumber: "0001234",
          issuedAt: now,
          outcomeUnknownReason: "The device response is uncertain.",
        }),
      ),
    ).toThrow("OutcomeUnknown database record contains inconsistent outcome data.");
  });

  it("rejects a receipt with an invalid issue date", () => {
    expect(() =>
      toDomainRecord(
        makeRow({
          status: "Succeeded",
          receiptNumber: "0001234",
          issuedAt: new Date("invalid"),
        }),
      ),
    ).toThrow("Database record contains an invalid date.");
  });

  it("rejects an invalid creation date", () => {
    expect(() => toDomainRecord(makeRow({ createdAt: new Date("invalid") }))).toThrow(
      "Database record contains an invalid date.",
    );
  });

  it("rejects an invalid update date", () => {
    expect(() => toDomainRecord(makeRow({ updatedAt: new Date("invalid") }))).toThrow(
      "Database record contains an invalid date.",
    );
  });
});
