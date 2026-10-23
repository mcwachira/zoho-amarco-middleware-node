import { describe, expect, it } from "vitest";
import { createFiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";

describe("Fiscalization record creation", () => {
    // A fixed timestamp makes the test predictable on every machine.
    const now = new Date("2026-10-22T09:00:00.000Z");

    it("creates a record in Pending state", () => {
        const record = createFiscalizationRecord(
            {
                id: "record-001",
                zohoInvoiceId: "zoho-invoice-123",
            },
            now,
        );

        expect(record.id).toBe("record-001");
        expect(record.zohoInvoiceId).toBe("zoho-invoice-123");
        expect(record.status).toBe("Pending");
        expect(record.createdAt).toEqual(now);
        expect(record.updatedAt).toEqual(now);
        expect(record.receipt).toBeNull();
        expect(record.failure).toBeNull();
    });

    it("trims whitespace around identifiers", () => {
        const record = createFiscalizationRecord(
            {
                id: "  record-001  ",
                zohoInvoiceId: "  zoho-invoice-123  ",
            },
            now,
        );

        expect(record.id).toBe("record-001");
        expect(record.zohoInvoiceId).toBe("zoho-invoice-123");
    });

    it("rejects an empty record ID", () => {
        expect(() =>
            createFiscalizationRecord(
                { id: "   ", zohoInvoiceId: "zoho-invoice-123" },
                now,
            ),
        ).toThrow("Fiscalization record ID must not be empty.");
    });

    it("rejects an empty Zoho invoice ID", () => {
        expect(() =>
            createFiscalizationRecord(
                { id: "record-001", zohoInvoiceId: "   " },
                now,
            ),
        ).toThrow("Zoho invoice ID must not be empty.");
    });

    it("creates independent timestamp objects", () => {
        const record = createFiscalizationRecord(
            { id: "record-001", zohoInvoiceId: "zoho-invoice-123" },
            now,
        );

        // Both timestamps represent the same instant, but are separate objects.
        expect(record.createdAt).toEqual(record.updatedAt);
        expect(record.createdAt).not.toBe(record.updatedAt);
    });
});