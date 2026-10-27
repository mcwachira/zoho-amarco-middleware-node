export interface FiscalCustomerProfile {
  readonly id: string;
  readonly zohoCustomerId: string;
  readonly companyName: string;
  readonly clientPin: string;
  readonly headquarters: string;
  readonly address: string;
  readonly postalCodeAndCity: string;
  readonly exemptionNumber: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type FiscalCustomerProfileData = Omit<
  FiscalCustomerProfile,
  "id" | "zohoCustomerId" | "createdAt" | "updatedAt"
>;

export type NewFiscalCustomerProfile = FiscalCustomerProfileData & {
  readonly zohoCustomerId: string;
};

/**
 * Customer identity is unique within the single Zoho organization configured
 * for this middleware installation.
 */
export interface FiscalCustomerProfileRepository {
  findByZohoCustomerId(zohoCustomerId: string): Promise<FiscalCustomerProfile | null>;

  /** Creates a profile and fails with DuplicateFiscalProfileError if it exists. */
  create(profile: NewFiscalCustomerProfile): Promise<FiscalCustomerProfile>;

  /**
   * Replaces the mutable profile fields without changing its Zoho identity.
   * Fails with FiscalProfileNotFoundError when no matching profile exists.
   */
  update(
    zohoCustomerId: string,
    profile: FiscalCustomerProfileData,
  ): Promise<FiscalCustomerProfile>;
}
