export const FISCALIZATION_SNAPSHOT_VERSION = 1 as const;

export interface FiscalizationSnapshotInvoice {
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

export interface FiscalizationSnapshotCustomer {
  readonly zohoCustomerId: string;
  readonly companyName: string;
  readonly clientPin: string;
  readonly headquarters: string;
  readonly address: string;
  readonly postalCodeAndCity: string;
  readonly exemptionNumber: string | null;
  readonly traderSystemInvoiceNumber: string;
}

export interface FiscalizationSnapshotLineProfile {
  readonly sourceLineId: string;
  readonly zohoItemId: string;
  readonly measureUnit: string;
  readonly hsCode: string;
  readonly hsName: string;
  readonly vatClass: string;
  readonly vatGroupRate: string;
}

export interface FiscalizationSnapshotPayment {
  readonly paymentId: string;
  readonly paymentNumber: string | null;
  readonly paymentMode: string | null;
  readonly amount: string;
  readonly date: string | null;
  readonly referenceNumber: string | null;
  readonly description: string | null;
  readonly source: Readonly<Record<string, unknown>>;
}

export interface FiscalizationSnapshot {
  readonly schemaVersion: typeof FISCALIZATION_SNAPSHOT_VERSION;
  readonly snapshotId: string;
  readonly registeredAt: string;
  readonly zohoOrganizationId: string;
  readonly invoice: FiscalizationSnapshotInvoice;
  readonly customer: FiscalizationSnapshotCustomer;
  readonly lineProfiles: readonly FiscalizationSnapshotLineProfile[];
  readonly payments?: readonly FiscalizationSnapshotPayment[] | undefined;
}
