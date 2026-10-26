
import { describe, expect, it, vi } from "vitest";

import type { RegisterFiscalizationRequestService } from "../../src/application/fiscalization/register-fiscalization-request.js";
import { PrepareFiscalizationRequestService } from "../../src/application/fiscalization/prepare-fiscalization-request.js";
import type { FiscalizationRecord } from "../../src/domain/fiscalization/fiscalization-record.js";
import type { ZohoInvoiceService } from "../../src/application/zoho/zoho-invoice-service.js";
import type { FiscalInvoiceCandidate } from "../../src/application/zoho/zoho-invoice-mapper.js";

const candidate: FiscalInvoiceCandidate = {
    zohoInvoiceId: "zoho-invoice-001",
    invoiceNumber: "INV-001",
    customerId: "customer-1",
    customerName: "Example Customer",
    currencyCode: "KES",
    lines: [
        {
            sourceLineId: "line-1",
            itemId: "item-1",
            description: "Test product",
            quantity: "2",
            unitPrice: "150",
            lineTotal: "300",
            taxId: "tax-1",
            taxName: "Source tax",
            taxType: "tax",
            taxPercentage: "16",
        },
    ],
    subtotal: "300",
    taxTotal: "48",
    total: "348",
};

const record = {
    id: "request-001",
    zohoInvoiceId: candidate.zohoInvoiceId,
    status: "Pending",
} as FiscalizationRecord;

function createHarness() {
    const invoiceService = {
        getFiscalInvoiceCandidate: vi.fn().mockResolvedValue({
            success: true,
            candidate,
        }),
    } satisfies Pick<ZohoInvoiceService, "getFiscalInvoiceCandidate">;

    const registrationService = {
        register: vi.fn().mockResolvedValue(record),
    } satisfies Pick<RegisterFiscalizationRequestService, "register">;

    const service = new PrepareFiscalizationRequestService(
        invoiceService,
        registrationService as RegisterFiscalizationRequestService,
        () => "request-001",
    );

    return { service, invoiceService, registrationService };
}

describe("PrepareFiscalizationRequestService", () => {
    it("maps the invoice and registers a Pending request", async () => {
        const { service, invoiceService, registrationService } = createHarness();

        const result = await service.prepare(candidate.zohoInvoiceId);

        expect(invoiceService.getFiscalInvoiceCandidate).toHaveBeenCalledWith(
            candidate.zohoInvoiceId,
        );
        expect(registrationService.register).toHaveBeenCalledWith({
            id: "request-001",
            invoice: candidate,
        });
        expect(result).toEqual({ kind: "registered", record });
    });

    it("does not register an invoice that fails mapping", async () => {
        const { service, invoiceService, registrationService } = createHarness();

        invoiceService.getFiscalInvoiceCandidate.mockResolvedValue({
            success: false,
            errors: [{ code: "INVALID_INVOICE", message: "Invoice is invalid" }],
        });

        const result = await service.prepare(candidate.zohoInvoiceId);

        expect(result.kind).toBe("mapping-failed");
        expect(registrationService.register).not.toHaveBeenCalled();
    });

    it("propagates Zoho retrieval errors without registering a request", async () => {
        const { service, invoiceService, registrationService } = createHarness();

        invoiceService.getFiscalInvoiceCandidate.mockRejectedValue(
            new Error("Zoho request failed"),
        );

        await expect(
            service.prepare(candidate.zohoInvoiceId),
        ).rejects.toThrow("Zoho request failed");

        expect(registrationService.register).not.toHaveBeenCalled();
    });
});
