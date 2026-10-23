# Rollback plan for 20261022120000_alert_indexes
Expand only: two new indexes used by the alert checks of the worker (0.7.5). The previous app version (0.7.4) ignores them,
so an app rollback needs no schema change.

To remove the schema change (only with approval, after the app is back on 0.7.4):
```sql
DROP INDEX IF EXISTS "AuditLog_action_createdAt_idx";
DROP INDEX IF EXISTS "Outbox_deadLetteredAt_idx";
```
Then delete the row for this migration from `_prisma_migrations`.
