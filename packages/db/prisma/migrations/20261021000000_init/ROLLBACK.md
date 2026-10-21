# Rollback plan for 20261021000000_init
Initial migration on an empty database: rollback is restoring the pre-deploy snapshot (docs/runbook.md). No down script is provided because Prisma has no down migrations; later migrations follow expand and contract so the previous app version keeps working.
