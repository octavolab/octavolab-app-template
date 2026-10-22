#!/usr/bin/env bash
# Deploy to AWS Lightsail Container Service. Usage: infra/deploy.sh staging|prod
# AWS credentials: short-lived, for the per-project deploy role (Módulo C, 8.2; see infra/README.md). In CI they come from
# GitHub OIDC (aws-actions/configure-aws-credentials with role-to-assume); locally from `aws sso login` or
# `aws sts assume-role` with MFA for the same role. No IAM user access keys. Production only with Jaime's approval (N07).
set -euo pipefail
ENV="${1:?staging|prod}"
SERVICE="${LIGHTSAIL_SERVICE:-${PROJECT_NAME:?set PROJECT_NAME}-$ENV}"
REGION="${AWS_REGION:-eu-west-2}"
VERSION="$(git describe --tags --always)"
echo "Deploying $VERSION to $SERVICE ($REGION)"
# -q keeps the deploy log short enough for GitHub to show it whole (errors are still printed).
docker build -q -f infra/Dockerfile -t "$SERVICE:app" .
aws lightsail push-container-image --region "$REGION" --service-name "$SERVICE" --label app --image "$SERVICE:app"
sed -e "s/:SERVICE_NAME.app.latest/:$SERVICE.app.latest/g" -e "s/\${APP_VERSION}/$VERSION/g" infra/lightsail.json > /tmp/lightsail.$ENV.json
# Lightsail replaces the whole deployment: carry over the environment of the ACTIVE deployment (secrets never live in this repo).
aws lightsail get-container-service-deployments --region "$REGION" --service-name "$SERVICE" --query "deployments[?state=='ACTIVE'] | [0].containers" --output json > "/tmp/active.$ENV.json"
# Source of truth for secrets (ASVS 6.4.1): AWS Secrets Manager secret "<PROJECT_NAME>/<env>", a JSON object such as
# {"DATABASE_URL": "...", "SESSION_SECRET": "...", "TOTP_ENC_KEY": "..."}. Rotating = updating the secret and redeploying.
# Its values win over the carried-over environment. If the secret does not exist yet, the deploy keeps the active
# environment and says so (never fails open: the API refuses to start without its required variables).
SECRET_ID="${SECRET_ID:-${PROJECT_NAME:-$SERVICE}/$ENV}"
umask 077
# Files with merged secrets never outlive the script, whatever path it exits by (a failed snapshot included).
trap 'rm -f "/tmp/secrets.$ENV.json" "/tmp/secrets.$ENV.err" "/tmp/lightsail.$ENV.json" "/tmp/active.$ENV.json" "/tmp/seed.$ENV.json"' EXIT
if aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text > "/tmp/secrets.$ENV.json" 2> "/tmp/secrets.$ENV.err"; then
  echo "Secrets: merged from Secrets Manager ($SECRET_ID)"; echo "::notice title=Secrets Manager in use::merged from $SECRET_ID"
elif grep -q "ResourceNotFoundException" "/tmp/secrets.$ENV.err" && [ "$ENV" != "prod" ] && [ "${SEED_SECRET_FROM_ACTIVE:-1}" = "1" ] \
  && python3 - "$ENV" <<'PY'
# One-time seed outside production: the secret does not exist yet, so create it from the ACTIVE app container's
# environment (the values a human already typed in the Lightsail console). Values are never printed; the file is 0600.
import json,sys
env=sys.argv[1]; act=json.load(open(f'/tmp/active.{env}.json')) or {}
app=act.get('app',{}).get('environment',{})
keys=[k for k in ("DATABASE_URL","SESSION_SECRET","TOTP_ENC_KEY","OPS_EMAIL") if app.get(k)]
if "DATABASE_URL" not in keys or "SESSION_SECRET" not in keys: sys.exit(1)
json.dump({k: app[k] for k in keys}, open(f'/tmp/seed.{env}.json','w'))
print("Secrets: seeding keys", ",".join(keys))
PY
then
  if aws secretsmanager create-secret --region "$REGION" --name "$SECRET_ID" --secret-string "file:///tmp/seed.$ENV.json" \
       --tags "Key=project,Value=${PROJECT_NAME:-$SERVICE}" "Key=env,Value=$ENV" --query Name --output text 2> "/tmp/secrets.$ENV.err"; then
    mv "/tmp/seed.$ENV.json" "/tmp/secrets.$ENV.json"
    echo "Secrets: created $SECRET_ID from the active environment and merged from Secrets Manager ($SECRET_ID)"
    echo "::notice title=Secrets Manager in use::created $SECRET_ID from the active environment (one-time seed) and merged"
  else
    rm -f "/tmp/seed.$ENV.json"; echo "{}" > "/tmp/secrets.$ENV.json"
    echo "::warning title=Secrets Manager not in use::could not create $SECRET_ID (the deploy role needs the ProjectSecrets statement); staging keeps the Lightsail environment (ASVS 6.4.1 Partial)"
  fi
elif grep -qE "ResourceNotFoundException|AccessDeniedException" "/tmp/secrets.$ENV.err" && [ "$ENV" != "prod" ]; then
  # Outside production only: a secret that does not exist yet, or a role without the ProjectSecrets statement yet, falls back to
  # the active environment with a visible CI warning. Production requires the secret (ASVS 6.4.1) and fails instead.
  echo "{}" > "/tmp/secrets.$ENV.json"
  echo "::warning title=Secrets Manager not in use::$SECRET_ID missing or not readable by the deploy role; staging keeps the Lightsail environment (ASVS 6.4.1 Partial)"
else
  # AccessDenied, network errors or a missing secret in prod: fail closed, never deploy with unknown secrets.
  echo "Secrets: cannot read $SECRET_ID; deploy stopped:"; sed 's/arn:[^ ]*/<arn>/g' "/tmp/secrets.$ENV.err" | head -3; exit 1
fi
rm -f "/tmp/secrets.$ENV.err"
python3 - "$ENV" <<'EOF'
import json,sys
env=sys.argv[1]; new=json.load(open(f'/tmp/lightsail.{env}.json')); act=json.load(open(f'/tmp/active.{env}.json')) or {}
sec=json.load(open(f'/tmp/secrets.{env}.json')) or {}
if not isinstance(sec,dict) or not all(isinstance(k,str) and isinstance(v,str) for k,v in sec.items()):
    sys.exit("Secrets Manager value must be a flat JSON object of strings")
for name,c in new['containers'].items():
    base={**act.get(name,{}).get('environment',{}),**c.get('environment',{})}
    c['environment']={**base,**sec} if name=='app' else base
# The worker validates the same environment as the API (DATABASE_URL, SESSION_SECRET, APP_URL, OPS_EMAIL, INTEGRATIONS_MODE):
# it inherits the app container's variables; its own values (NODE_ENV and any override) win.
if 'worker' in new['containers'] and 'app' in new['containers']:
    w=new['containers']['worker']
    w['environment']={**new['containers']['app'].get('environment',{}),**w.get('environment',{})}
json.dump(new,open(f'/tmp/lightsail.{env}.json','w'))
EOF
# Production: snapshot of the database before the new version starts (its migrations run at container start, ADR 0005).
# Taken after the image push and the secret merge, so a failed build or a missing secret leaves no snapshot behind,
# and confirmed "available" before the deployment is created. Fails closed: no confirmed snapshot, no deploy. The deploy role may snapshot only databases
# tagged project and env.
if [ "$ENV" = "prod" ]; then
  DB="${LIGHTSAIL_DB:-$SERVICE-db}"
  SNAP="$DB-pre-$(echo "$VERSION" | tr -c 'A-Za-z0-9\n' '-')-$(date -u +%Y%m%d%H%M)"
  aws lightsail create-relational-database-snapshot --region "$REGION" --relational-database-name "$DB" --relational-database-snapshot-name "$SNAP" > /dev/null
  for i in $(seq 1 90); do
    SNAP_STATE="$(aws lightsail get-relational-database-snapshot --region "$REGION" --relational-database-snapshot-name "$SNAP" --query relationalDatabaseSnapshot.state --output text 2>/dev/null || echo pending)"
    [ "$SNAP_STATE" = "available" ] && break; echo "Snapshot $SNAP is $SNAP_STATE; waiting ($i/90)"; sleep 10
  done
  if [ "$SNAP_STATE" != "available" ]; then
    echo "Snapshot $SNAP not available in time (state: $SNAP_STATE); deploy stopped. Last answer from AWS:"
    aws lightsail get-relational-database-snapshot --region "$REGION" --relational-database-snapshot-name "$SNAP" --query relationalDatabaseSnapshot.state --output text 2>&1 | sed 's/arn:[^ ]*/<arn>/g' | head -3 || true
    exit 1
  fi
  echo "Snapshot available: $SNAP"
fi
# Lightsail accepts one deployment at a time: wait (up to 15 min) until the service is no longer deploying.
for i in $(seq 1 90); do
  STATE="$(aws lightsail get-container-services --region "$REGION" --service-name "$SERVICE" --query "containerServices[0].state" --output text)"
  case "$STATE" in DEPLOYING|UPDATING|PENDING) echo "Service is $STATE; waiting ($i/90)"; sleep 10;; *) break;; esac
done
aws lightsail create-container-service-deployment --region "$REGION" --service-name "$SERVICE" --cli-input-json "file:///tmp/lightsail.$ENV.json"
rm -f "/tmp/secrets.$ENV.json" "/tmp/lightsail.$ENV.json" "/tmp/active.$ENV.json"
# Wait for the new deployment to become active, so the smoke test checks the new version (not the previous one).
for i in $(seq 1 90); do
  STATE="$(aws lightsail get-container-services --region "$REGION" --service-name "$SERVICE" --query "containerServices[0].state" --output text)"
  [ "$STATE" = "RUNNING" ] && break; echo "Service is $STATE; waiting ($i/90)"; sleep 10
done
[ "$STATE" = "RUNNING" ] || { echo "Deployment did not become RUNNING in time (state: $STATE)"; exit 1; }
echo "version=$VERSION" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "Deployment created. Watch: aws lightsail get-container-services --service-name $SERVICE --region $REGION"
