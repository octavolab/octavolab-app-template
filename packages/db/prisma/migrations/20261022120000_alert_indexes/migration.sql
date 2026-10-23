-- CreateIndex
CREATE INDEX "Outbox_deadLetteredAt_idx" ON "Outbox"("deadLetteredAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
