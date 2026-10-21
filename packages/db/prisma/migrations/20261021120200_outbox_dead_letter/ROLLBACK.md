# Rollback plan for 20261021120200_outbox_dead_letter
Expand only: a nullable column. The previous worker ignores it (it already stopped at 8 attempts), so rolling back the app is enough.
To drop it after the previous version is live: `ALTER TABLE "Outbox" DROP COLUMN "deadLetteredAt";`
To replay a dead-lettered event after fixing its cause: `UPDATE "Outbox" SET "deadLetteredAt" = NULL, attempts = 0, "lockedUntil" = NULL WHERE id = '<id>';`
