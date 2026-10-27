import { InvalidFiscalProfileError, type FiscalProfileKind } from "./fiscal-profile-errors.js";
import type {
  FiscalCustomerProfileData,
  NewFiscalCustomerProfile,
} from "./fiscal-customer-profile-repository.js";
import type {
  FiscalItemProfileData,
  NewFiscalItemProfile,
} from "./fiscal-item-profile-repository.js";

function requiredText(field: string, value: string, maxLength: number): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new InvalidFiscalProfileError(field, `${field} must not be empty.`);
  }

  if (normalized.length > maxLength) {
    throw new InvalidFiscalProfileError(field, `${field} must not exceed ${maxLength} characters.`);
  }

  return normalized;
}

function profileIdentity(kind: FiscalProfileKind, identity: string): string {
  return requiredText(kind === "customer" ? "zohoCustomerId" : "zohoItemId", identity, 255);
}

export function normalizeCustomerIdentity(identity: string): string {
  return profileIdentity("customer", identity);
}

export function normalizeItemIdentity(identity: string): string {
  return profileIdentity("item", identity);
}

export function normalizeNewCustomerProfile(
  profile: NewFiscalCustomerProfile,
): NewFiscalCustomerProfile {
  return {
    zohoCustomerId: normalizeCustomerIdentity(profile.zohoCustomerId),
    ...normalizeCustomerProfileData(profile),
  };
}

export function normalizeCustomerProfileData(
  profile: FiscalCustomerProfileData,
): FiscalCustomerProfileData {
  const exemptionNumber =
    profile.exemptionNumber === null
      ? null
      : requiredText("exemptionNumber", profile.exemptionNumber, 30);

  return {
    companyName: requiredText("companyName", profile.companyName, 30),
    clientPin: requiredText("clientPin", profile.clientPin, 14),
    headquarters: requiredText("headquarters", profile.headquarters, 30),
    address: requiredText("address", profile.address, 30),
    postalCodeAndCity: requiredText("postalCodeAndCity", profile.postalCodeAndCity, 30),
    exemptionNumber,
  };
}

export function normalizeNewItemProfile(profile: NewFiscalItemProfile): NewFiscalItemProfile {
  return {
    zohoItemId: normalizeItemIdentity(profile.zohoItemId),
    ...normalizeItemProfileData(profile),
  };
}

export function normalizeItemProfileData(profile: FiscalItemProfileData): FiscalItemProfileData {
  const vatGroupRate = requiredText("vatGroupRate", profile.vatGroupRate, 20);

  if (!/^-?\d+(?:\.\d+)?$/.test(vatGroupRate)) {
    throw new InvalidFiscalProfileError("vatGroupRate", "vatGroupRate must be a decimal string.");
  }

  return {
    measureUnit: requiredText("measureUnit", profile.measureUnit, 3),
    hsCode: requiredText("hsCode", profile.hsCode, 10),
    hsName: requiredText("hsName", profile.hsName, 20),
    // Classification values remain explicit configuration. No Kenyan tax
    // classification is inferred or approved by persistence validation.
    vatClass: requiredText("vatClass", profile.vatClass, 1),
    vatGroupRate,
  };
}
