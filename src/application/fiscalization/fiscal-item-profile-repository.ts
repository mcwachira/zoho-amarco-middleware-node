export interface FiscalItemProfile {
  readonly id: string;
  readonly zohoItemId: string;
  readonly measureUnit: string;
  readonly hsCode: string;
  readonly hsName: string;
  readonly vatClass: string;
  readonly vatGroupRate: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type FiscalItemProfileData = Omit<
  FiscalItemProfile,
  "id" | "zohoItemId" | "createdAt" | "updatedAt"
>;

export type NewFiscalItemProfile = FiscalItemProfileData & {
  readonly zohoItemId: string;
};

/**
 * Item identity is unique within the single Zoho organization configured
 * for this middleware installation.
 */
export interface FiscalItemProfileRepository {
  findByZohoItemId(zohoItemId: string): Promise<FiscalItemProfile | null>;

  /** Creates a profile and fails with DuplicateFiscalProfileError if it exists. */
  create(profile: NewFiscalItemProfile): Promise<FiscalItemProfile>;

  /**
   * Replaces the mutable profile fields without changing its Zoho identity.
   * Fails with FiscalProfileNotFoundError when no matching profile exists.
   */
  update(zohoItemId: string, profile: FiscalItemProfileData): Promise<FiscalItemProfile>;

  /** Deletes a profile without changing any immutable fiscalization snapshots. */
  delete(zohoItemId: string): Promise<void>;
}
