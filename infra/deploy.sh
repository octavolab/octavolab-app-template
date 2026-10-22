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
docker build -f infra/Dockerfile -t "$SERVICE:app" .
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
if aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text > "/tmp/secrets.$ENV.json" 2>/dev/null; then
  echo "Secrets: merged from Secrets Manager ($SECRET_ID)"
else
  echo "{}" > "/tmp/secrets.$ENV.json"; echo "Secrets: $SECRET_ID not found or not readable; keeping the active environment"
fi
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
