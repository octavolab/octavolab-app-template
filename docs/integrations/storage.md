# File storage — Lightsail bucket (S3-compatible)
- Purpose: private object storage for tenant files (documents, proofs of delivery, imports). Adapter:
  `packages/integrations/src/storage.ts` (`S3Storage`, `FakeStorage`, `tenantKey`, `presignTenantUpload`), contract
  `StorageProvider` in `contracts.ts`.
- Official docs (URL, date read): https://docs.aws.amazon.com/lightsail/latest/userguide/buckets.html (buckets, access keys,
  access permissions), https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html, read 2026-10-22.
- Auth: a **bucket access key** created in Lightsail for this bucket (`S3_ACCESS_KEY` / `S3_SECRET_KEY`). It is scoped to one
  bucket and is not an IAM user. Lightsail containers cannot assume IAM roles, so the adapter always passes these credentials
  explicitly and never uses the SDK's default credential chain. CI does not touch the bucket, so `infra/iam-policy-project.json`
  is unchanged.
- Sandbox: a separate staging bucket (e.g. `octavolab-staging-files`, tag `project=octavolab`) with its own access key.
- Live mode checklist: production bucket and key (Jaime's approval for the recurring cost, N07) · `STORAGE_MODE=live`,
  `ALLOW_LIVE=true` · upload and download tested from the web app · recorded in `docs/learnings.md`.
- Owner: tech lead in `OWNERSHIP.md`.

## Bucket setup (staging)
```bash
aws lightsail create-bucket --region eu-west-2 --bucket-name octavolab-staging-files --bundle-id small_1_0 --tags key=project,value=octavolab
aws lightsail update-bucket --region eu-west-2 --bucket-name octavolab-staging-files --access-rules getObject=private,allowPublicOverrides=false
aws lightsail create-bucket-access-key --region eu-west-2 --bucket-name octavolab-staging-files   # shows the secret ONCE
```
Run these as a human with a short-lived session (not CI); bucket creation is a recurring cost and needs Jaime's approval (N07).
Put the key pair straight into the Lightsail environment, never in a file or chat. Browser uploads additionally need a bucket
CORS rule allowing `PUT` from `APP_URL` with the `content-type` header; configure it when the first upload feature ships and
record the exact command that worked in `docs/learnings.md` (not exercised yet).

## Behaviour
- Keys are built server-side only: `tenants/{tenantId}/{purpose}/{uuid}.{ext}`. Every adapter call rejects a key outside
  `tenants/{tenantId}/...` or with `..`, so a caller cannot cross tenants even by mistake.
- Uploads: `presignTenantUpload(storage, { tenantId, purpose, contentType, contentLength })` returns a pre-signed PUT URL
  (default 10 min, hard maximum 15 min) plus the headers the browser must send. `Content-Type` and `Content-Length` are signed,
  so S3 rejects an upload of another type or size. Allowed types: PDF, PNG, JPEG, WebP, CSV; default limit 10 MB.
- Downloads: pre-signed GET, at most 15 minutes. The bucket stays private.
- Checksums: the SDK's default CRC32 on PutObject is turned off unless required, otherwise pre-signed browser uploads fail.
- Errors: `StorageError` `s3 <status> <SDK error name>` (never the SDK message, which can echo keys); `headObject` returns
  `null` for a missing object.
- Not wired to an HTTP endpoint yet: the first feature that stores files adds its route (with zod validation, tenant guard and
  audit) on top of `presignTenantUpload`.

## Key rotation
Create a second bucket access key (a bucket can have two) → update `S3_ACCESS_KEY` / `S3_SECRET_KEY` in Lightsail → redeploy →
delete the old key (`aws lightsail delete-bucket-access-key`, human, with approval).
