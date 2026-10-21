# Rollback plan for 20261021130100_user_totp_2fa
Expand only: two nullable columns on `User` and a new table. The previous app version (0.6.0) ignores them.

Security caveat: 0.6.0 does not enforce 2FA. Rolling the app back silently downgrades every account that enabled 2FA to
password-only sign-in. Do it only with Jaime's approval, and announce it to the users with 2FA enabled:
```sql
SELECT id, email, role FROM "User" WHERE "totpEnabledAt" IS NOT NULL;
```
Leave the data in place during an app rollback, so moving forward again restores 2FA for those accounts without re-enrollment.

To remove the schema change (only with approval, after the app is back on 0.6.0):
```sql
DROP TABLE "MfaRecoveryCode";
ALTER TABLE "User" DROP COLUMN "totpLastStep", DROP COLUMN "totpEnabledAt";
UPDATE "User" SET "totpSecret" = NULL;
```
Then delete the row for this migration from `_prisma_migrations`.
