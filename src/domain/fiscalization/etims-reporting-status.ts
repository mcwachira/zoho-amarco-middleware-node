import type { EtimsReportingState } from "./etims-reporting.js";

export const ETIMS_REPORTING_STATUS = "not_configured" as const satisfies EtimsReportingState;

export type EtimsReportingStatus = EtimsReportingState;

export const ETIMS_REPORTING_BLOCKERS = [
  "vscu_runtime_not_configured",
  "submission_transport_authentication_unverified",
  "invoice_and_tax_mapping_incomplete",
  "verified_receipt_lifecycle_unavailable",
  "duplicate_reconciliation_unverified",
] as const;

export type EtimsReportingBlocker = (typeof ETIMS_REPORTING_BLOCKERS)[number];
