export const fiscalizationStatuses = [
  "Pending",
  "InProgress",
  "Succeeded",
  "Failed",
  "OutcomeUnknown",
] as const;

export type FiscalizationStatus = (typeof fiscalizationStatuses)[number];
