# ADR 0005: Database migrations run when the app container starts, guarded by expand-only rules
Date: 2026-10-22 · Status: accepted (replaces the roadmap item "migration as its own deploy step")

Context: Módulo C 8 point 6 asks for migrations to run as a deploy step before the new version is activated. On AWS Lightsail the managed PostgreSQL has public mode off (the right setting) and Lightsail offers no one-shot task: every container in a deployment runs continuously. The GitHub runner therefore has no network path to the database, and a "migrate" container would restart in a loop after finishing.

Decision: keep `prisma migrate deploy` in the `app` container command (only `app` migrates; `worker` overrides the command) and make it safe instead of moving it:
1. Expand only by default. Every migration says what it is on the second line of its `ROLLBACK.md` ("Expand only", "Contract step" or "Initial migration"); `pnpm --filter @octavolab/db validate:sql` fails the CI otherwise. The previous image must keep working on the new schema, so a rollback (`infra/rollback.sh`, runbook) never needs a schema change.
2. Contract steps (dropping or tightening a column) ship in a later release than the code that stops using it, in their own PR, with Jaime's approval recorded in the PR and a snapshot taken first (runbook).
3. Concurrency: `prisma migrate deploy` takes a PostgreSQL advisory lock, so two starting containers never apply the same migration twice; each migration file runs in its own transaction.
4. A failing migration makes the new container fail its health check; Lightsail then keeps the previous deployment active [to verify on the first failure in staging and record in docs/learnings.md].
5. Before every production deploy: manual snapshot of the database (runbook "Deploy"), so a bad migration is recoverable.

Consequences: no public database and no extra paid resource; the expand/contract discipline is enforced by CI, not by memory. Revisit if the project moves to a platform with one-shot tasks (ECS RunTask, Fly machines) or the database gains a private network path from CI.
