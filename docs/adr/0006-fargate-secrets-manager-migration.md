# ADR 0006: When and how to move from Lightsail to ECS Fargate + Secrets Manager
Date: 2026-10-22 · Status: proposed (not scheduled) · Number 0005 is used by the open integrations PR (#17).

## Context
Lightsail container services have no IAM task role. Secrets are therefore plaintext environment variables, visible to
every Lightsail reader and kept forever in the deployment history (`docs/secrets.md`). Giving containers AWS keys to read
Secrets Manager at runtime would replace those secrets with a longer-lived, broader one, so we do not do it.

## Decision
Stay on Lightsail while staging and production hold no real customer data and no live provider keys. Move to ECS Fargate
when ANY of these becomes true: real customer data in production, `INTEGRATIONS_MODE=live`, a compliance requirement for
secret access auditing, or more than one API instance (Lightsail Nano/Micro limits).

Target design:
- ECS Fargate service (app + worker task definitions) in eu-west-2, private subnets, ALB in front; RDS PostgreSQL 16 (or
  keep the Lightsail database through VPC peering for the transition); ElastiCache or a Redis task.
- **Task execution role** with `secretsmanager:GetSecretValue` on `octavolab/<env>` only; task definitions reference each
  secret with `valueFrom` (no values in the task definition, no history of values). Optional KMS CMK.
- **Task role** with nothing by default (least privilege); add S3/SES permissions per feature.
- Rotation: Secrets Manager rotation for the RDS password; `SESSION_SECRET` rotated by updating the secret and forcing a new
  deployment; `TOTP_ENC_KEY` still needs the key-ring change described in the runbook before it can rotate.
- Deploys: same GitHub OIDC model, a deploy role allowed to register task definitions and update the service only.
- CloudTrail data events on the secret give an audit trail of every read.

## Consequences
- Higher monthly cost (ALB, NAT or VPC endpoints, Fargate vCPU/memory) than Lightsail Nano: needs Jaime's approval (N07).
- More infrastructure to own (VPC, ALB, IAM). Should be expressed as code (CDK or Terraform) in the same repo.
- Migration plan: provision in parallel, copy secrets into Secrets Manager, point a staging DNS name at the ALB, run the
  smoke test (`version == SHA`), switch DNS, keep Lightsail for one week as rollback, then delete it (destructive: approval).
