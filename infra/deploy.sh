#!/usr/bin/env bash
# Deploy to AWS Lightsail Container Service. Usage: infra/deploy.sh staging|prod
# AWS credentials: short-lived, for the per-project deploy role (Módulo C, 8.2; see infra/README.md). In CI they come from
# GitHub OIDC (aws-actions/configure-aws-credentials with role-to-assume); locally from `aws sso login` or
# `aws sts assume-role` with MFA for the same role. No IAM user access keys. Production only with Jaime's approval (N07).
#
# The script exits 0 only when the NEW deployment version is ACTIVE (Lightsail health checks passed), so the smoke test
# that follows always runs against the code that was just deployed. FAILED, INACTIVE or no ACTIVE state within
# DEPLOY_TIMEOUT_SECONDS (default 600) exits 1 and prints the tail of every container's log.
set -euo pipefail
ENV="${1:?staging|prod}"
case "$ENV" in
  staging) APP_ENV=staging ;;
  prod) APP_ENV=production ;;
  *) echo "usage: infra/deploy.sh staging|prod" >&2; exit 2 ;;
esac
SERVICE="${LIGHTSAIL_SERVICE:-${PROJECT_NAME:?set PROJECT_NAME}-$ENV}"
REGION="${AWS_REGION:-eu-west-2}"
VERSION="$(git describe --tags --always)"
TIMEOUT="${DEPLOY_TIMEOUT_SECONDS:-600}"
POLL="${DEPLOY_POLL_SECONDS:-15}"
echo "Deploying $VERSION to $SERVICE ($REGION, APP_ENV=$APP_ENV)"
docker build -f infra/Dockerfile -t "$SERVICE:app" .
aws lightsail push-container-image --region "$REGION" --service-name "$SERVICE" --label app --image "$SERVICE:app"
sed -e "s/:SERVICE_NAME.app.latest/:$SERVICE.app.latest/g" -e "s/\${APP_VERSION}/$VERSION/g" -e "s/\${APP_ENV}/$APP_ENV/g" infra/lightsail.json > /tmp/lightsail.$ENV.json
# Lightsail replaces the whole deployment: carry over the environment of the ACTIVE deployment (secrets never live in this repo).
aws lightsail get-container-service-deployments --region "$REGION" --service-name "$SERVICE" --query "deployments[?state=='ACTIVE'] | [0].containers" --output json > "/tmp/active.$ENV.json"
python3 - "$ENV" <<'EOF'
import json,sys
env=sys.argv[1]; new=json.load(open(f'/tmp/lightsail.{env}.json')); act=json.load(open(f'/tmp/active.{env}.json')) or {}
for name,c in new['containers'].items():
    c['environment']={**act.get(name,{}).get('environment',{}),**c.get('environment',{})}
# The worker validates the same environment as the API (DATABASE_URL, SESSION_SECRET, APP_URL, OPS_EMAIL, the integration
# modes and their secrets): it inherits the app container's variables; its own values (NODE_ENV and any override) win.
if 'worker' in new['containers'] and 'app' in new['containers']:
    w=new['containers']['worker']
    w['environment']={**new['containers']['app'].get('environment',{}),**w.get('environment',{})}
json.dump(new,open(f'/tmp/lightsail.{env}.json','w'))
EOF
# Only the version number is read from the response: the full output contains the environment (secrets) and is never printed.
NEW_VERSION="$(aws lightsail create-container-service-deployment --region "$REGION" --service-name "$SERVICE" \
  --cli-input-json "file:///tmp/lightsail.$ENV.json" --query 'containerService.nextDeployment.version' --output text)"
rm -f "/tmp/lightsail.$ENV.json" "/tmp/active.$ENV.json"
if ! [[ "$NEW_VERSION" =~ ^[0-9]+$ ]]; then echo "could not read the new deployment version (got '$NEW_VERSION')" >&2; exit 1; fi
echo "Deployment version $NEW_VERSION created; waiting for ACTIVE (timeout ${TIMEOUT}s)"

print_logs() {
  local containers
  containers="$(aws lightsail get-container-service-deployments --region "$REGION" --service-name "$SERVICE" \
    --query "deployments[?version==\`$NEW_VERSION\`] | [0].containers | keys(@)" --output text 2>/dev/null || echo "app worker redis")"
  for c in $containers; do
    echo "----- last log lines of container '$c' (deployment $NEW_VERSION) -----"
    aws lightsail get-container-log --region "$REGION" --service-name "$SERVICE" --container-name "$c" \
      --query 'logEvents[-40:].[createdAt,message]' --output text 2>&1 || echo "(no log available for $c)"
  done
}

deadline=$((SECONDS + TIMEOUT))
state="UNKNOWN"
while (( SECONDS < deadline )); do
  state="$(aws lightsail get-container-service-deployments --region "$REGION" --service-name "$SERVICE" \
    --query "deployments[?version==\`$NEW_VERSION\`] | [0].state" --output text)"
  case "$state" in
    ACTIVE) echo "Deployment $NEW_VERSION ($VERSION) is ACTIVE"; exit 0 ;;
    FAILED|INACTIVE) echo "Deployment $NEW_VERSION ended $state; the previous deployment keeps serving" >&2; print_logs >&2; exit 1 ;;
    *) echo "  state=$state; next check in ${POLL}s"; sleep "$POLL" ;;
  esac
done
echo "Deployment $NEW_VERSION not ACTIVE after ${TIMEOUT}s (last state: $state)" >&2
print_logs >&2
exit 1
