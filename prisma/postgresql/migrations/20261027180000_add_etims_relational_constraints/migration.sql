DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "EtimsReportingOperation" operation
        LEFT JOIN "FiscalizationRecord" request
            ON request."id" = operation."fiscalizationRequestId"
        WHERE request."id" IS NULL
    ) THEN
        RAISE EXCEPTION 'eTIMS operations contain an orphaned fiscalization request reference; review data before applying relational constraints';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "EtimsReportingAttempt" attempt
        LEFT JOIN "EtimsReportingOperation" operation
            ON operation."id" = attempt."operationId"
        WHERE operation."id" IS NULL
    ) THEN
        RAISE EXCEPTION 'eTIMS attempts contain an orphaned operation reference; review data before applying relational constraints';
    END IF;
END $$;

ALTER TABLE "EtimsReportingOperation"
ADD CONSTRAINT "EtimsReportingOperation_fiscalizationRequestId_fkey"
FOREIGN KEY ("fiscalizationRequestId") REFERENCES "FiscalizationRecord"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EtimsReportingAttempt"
ADD CONSTRAINT "EtimsReportingAttempt_operationId_fkey"
FOREIGN KEY ("operationId") REFERENCES "EtimsReportingOperation"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
