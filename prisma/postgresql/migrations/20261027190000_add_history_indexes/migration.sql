CREATE INDEX "FiscalizationRecord_createdAt_id_idx"
ON "FiscalizationRecord"("createdAt", "id");

CREATE INDEX "FiscalizationRecord_status_createdAt_id_idx"
ON "FiscalizationRecord"("status", "createdAt", "id");
