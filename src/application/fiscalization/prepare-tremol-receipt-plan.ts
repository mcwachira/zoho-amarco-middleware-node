import type { FiscalCustomerProfileRepository } from "./fiscal-customer-profile-repository.js";
import type { FiscalItemProfileRepository } from "./fiscal-item-profile-repository.js";
import type { FiscalInvoiceCandidate } from "../zoho/zoho-invoice-mapper.js";
import {
  mapZohoInvoiceToTremolPlan,
  type FiscalLineMetadata,
  type ZohoTremolMappingResult,
} from "../../infrastructure/device/zoho-tremol-receipt-mapper.js";

export type PrepareTremolReceiptPlanResult = ZohoTremolMappingResult;

export class PrepareTremolReceiptPlan {
  constructor(
    private readonly customerProfiles: FiscalCustomerProfileRepository,
    private readonly itemProfiles: FiscalItemProfileRepository,
  ) {}

  async execute(invoice: FiscalInvoiceCandidate): Promise<PrepareTremolReceiptPlanResult> {
    // This receipt-plan workflow currently targets Kenya and KES only.
    // Reject other currencies before querying fiscal profile repositories.
    if (invoice.currencyCode !== "KES") {
      return {
        success: false,
        errors: [
          {
            field: "currencyCode",
            message:
              "Only KES invoices are supported by the current Tremol receipt-planning workflow.",
          },
        ],
      };
    }

    if (!invoice.customerId?.trim()) {
      return {
        success: false,
        errors: [
          {
            field: "customerId",
            message: "The Zoho invoice has no customer ID.",
          },
        ],
      };
    }

    const customer = await this.customerProfiles.findByZohoCustomerId(invoice.customerId);

    if (!customer) {
      return {
        success: false,
        errors: [
          {
            field: "customer",
            message: "No fiscal profile is configured for this Zoho customer.",
          },
        ],
      };
    }

    // Defend against a faulty repository returning a profile for another customer.
    if (customer.zohoCustomerId !== invoice.customerId) {
      return {
        success: false,
        errors: [
          {
            field: "customer",
            message: "The fiscal customer profile does not match the Zoho invoice customer.",
          },
        ],
      };
    }

    const lineMetadata: FiscalLineMetadata[] = [];

    for (const [index, line] of invoice.lines.entries()) {
      if (!line.itemId?.trim()) {
        return {
          success: false,
          errors: [
            {
              field: `invoice.lines[${index}].itemId`,
              message: "The Zoho invoice line has no item ID; fiscal metadata cannot be resolved.",
            },
          ],
        };
      }

      if (!line.sourceLineId?.trim()) {
        return {
          success: false,
          errors: [
            {
              field: `invoice.lines[${index}].sourceLineId`,
              message: "The Zoho invoice line has no stable line ID.",
            },
          ],
        };
      }

      const item = await this.itemProfiles.findByZohoItemId(line.itemId);

      if (!item) {
        return {
          success: false,
          errors: [
            {
              field: `invoice.lines[${index}].itemId`,
              message: `No fiscal profile is configured for Zoho item ${line.itemId}.`,
            },
          ],
        };
      }

      // A returned profile must belong to the requested Zoho item.
      if (item.zohoItemId !== line.itemId) {
        return {
          success: false,
          errors: [
            {
              field: `invoice.lines[${index}].itemId`,
              message: "The fiscal item profile does not match the Zoho invoice item.",
            },
          ],
        };
      }

      lineMetadata.push({
        sourceLineId: line.sourceLineId,
        vatClass: item.vatClass,
        measureUnit: item.measureUnit,
        hsCode: item.hsCode,
        hsName: item.hsName,
        vatGroupRate: item.vatGroupRate,
      });
    }

    return mapZohoInvoiceToTremolPlan({
      invoice,
      customer: {
        companyName: customer.companyName,
        clientPin: customer.clientPin,
        headquarters: customer.headquarters,
        address: customer.address,
        postalCodeAndCity: customer.postalCodeAndCity,
        ...(customer.exemptionNumber !== null ? { exemptionNumber: customer.exemptionNumber } : {}),
        traderSystemInvoiceNumber: invoice.invoiceNumber ?? invoice.zohoInvoiceId,
      },
      lineMetadata,
    });
  }
}
