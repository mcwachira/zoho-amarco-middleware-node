ALTER TABLE "EtimsReportingOperation"
    DROP CONSTRAINT "EtimsReportingOperation_status_check";

ALTER TABLE "EtimsReportingOperation"
    ADD CONSTRAINT "EtimsReportingOperation_status_check"
    CHECK ("status" IN ('not_configured', 'blocked', 'pending', 'in_progress', 'accepted', 'rejected', 'outcome_unknown', 'reconciliation_required', 'reconciling'));
