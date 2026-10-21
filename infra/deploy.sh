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
python3 - "$ENV" <<'EOF'
import json,sys
env=sys.argv[1]; new=json.load(open(f'/tmp/lightsail.{env}.json')); act=json.load(open(f'/tmp/active.{env}.json')) or {}
for name,c in new['containers'].items():
    c['environment']={**act.get(name,{}).get('environment',{}),**c.get('environment',{})}
# The worker validates the same environment as the API (DATABASE_URL, SESSION_SECRET, APP_URL, OPS_EMAIL, INTEGRATIONS_MODE):
# it inherits the app container's variables; its own values (NODE_ENV and any override) win.
if 'worker' in new['containers'] and 'app' in new['containers']:
    w=new['containers']['worker']
    w['environment']={**new['containers']['app'].get('environment',{}),**w.get('environment',{})}
json.dump(new,open(f'/tmp/lightsail.{env}.json','w'))
EOF
aws lightsail create-container-service-deployment --region "$REGION" --service-name "$SERVICE" --cli-input-json "file:///tmp/lightsail.$ENV.json"
echo "Deployment created. Watch: aws lightsail get-container-services --service-name $SERVICE --region $REGION"
