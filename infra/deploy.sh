#!/usr/bin/env bash
# Deploy to AWS Lightsail Container Service. Usage: infra/deploy.sh staging|prod
# AWS credentials: short-lived, for the per-project deploy role (Módulo C, 8.2; see infra/README.md). In CI they come from
# GitHub OIDC (aws-actions/configure-aws-credentials with role-to-assume); locally from `aws sso login` or
# `aws sts assume-role` with MFA for the same role. No IAM user access keys. Production only with Jaime's approval (N07).
#
# Safety rules (docs/runbook.md, "Deploy"):
#  1. Lock: abort (exit 3) if Lightsail reports a deployment in progress, and abort if the ACTIVE deployment changes while
#     this script runs (someone deployed or edited variables in the console): re-run instead of overwriting their change.
#  2. The new environment is built from the CURRENT active deployment (infra/deploy_env.py); before deploying, the
#     changed variable NAMES are printed, never their values.
#  3. The image carries the git SHA (build arg GIT_SHA -> /app/VERSION); APP_VERSION is no longer an env var.
#  4. The script succeeds only when the NEW deployment version is ACTIVE; FAILED/INACTIVE/timeout prints each container's
#     log tail and exits 1. The previous deployment keeps serving in that case.
#  5. Nothing that contains environment values is ever printed (create-deployment's response is queried for its version only).
set -euo pipefail
ENV="${1:?staging|prod}"
case "$ENV" in staging|prod) ;; *) echo "usage: infra/deploy.sh staging|prod" >&2; exit 2 ;; esac
SERVICE="${LIGHTSAIL_SERVICE:-${PROJECT_NAME:?set PROJECT_NAME}-$ENV}"
REGION="${AWS_REGION:-eu-west-2}"
TIMEOUT="${DEPLOY_TIMEOUT_SECONDS:-900}"
POLL="${DEPLOY_POLL_SECONDS:-10}"
LS=(aws lightsail --region "$REGION")

# A deploy from uncommitted changes would ship an image that does not match the SHA it reports.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to deploy: the working tree has uncommitted changes (the image would not match $(git rev-parse --short=7 HEAD))." >&2
  exit 2
fi
SHA="$(git rev-parse --short=7 HEAD)"

umask 077
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

service_state() { "${LS[@]}" get-container-services --service-name "$SERVICE" --query "containerServices[0].state" --output text; }
active_version() { "${LS[@]}" get-container-service-deployments --service-name "$SERVICE" --query "deployments[?state=='ACTIVE'] | [0].version" --output text; }
activating() { "${LS[@]}" get-container-service-deployments --service-name "$SERVICE" --query "length(deployments[?state=='ACTIVATING'])" --output text; }

check_lock() {
  local state pending
  state="$(service_state)"; pending="$(activating)"
  case "$state" in DEPLOYING|UPDATING|PENDING)
    echo "Refusing to deploy: $SERVICE is $state (another deployment or a console edit is in progress). Wait for it to finish, then re-run." >&2; exit 3 ;;
  esac
  if [ "$pending" != "0" ]; then
    echo "Refusing to deploy: $SERVICE has a deployment ACTIVATING. Wait for it to finish, then re-run." >&2; exit 3
  fi
}

echo "Deploying $SHA to $SERVICE ($REGION)"
check_lock
BASE_VERSION="$(active_version)"
echo "Active deployment: version $BASE_VERSION"

docker build -f infra/Dockerfile --build-arg "GIT_SHA=$SHA" -t "$SERVICE:app" .
"${LS[@]}" push-container-image --service-name "$SERVICE" --label app --image "$SERVICE:app"

sed -e "s/:SERVICE_NAME.app.latest/:$SERVICE.app.latest/g" infra/lightsail.json > "$WORK/template.json"
# Lightsail replaces the whole deployment: start from the environment of the ACTIVE deployment (secrets never live in this repo).
"${LS[@]}" get-container-service-deployments --service-name "$SERVICE" --query "deployments[?state=='ACTIVE'] | [0].containers" --output json > "$WORK/active.json"
# Optional deploy-time source for secrets (ASVS 6.4.1): Secrets Manager secret "<PROJECT_NAME>/<env>", a flat JSON object.
# Read with the deploy role's short-lived credentials; the containers never hold AWS keys. Its values win for the app
# container and are reported as such below. Missing secret = keep the active environment.
SECRET_ID="${SECRET_ID:-${PROJECT_NAME:-$SERVICE}/$ENV}"
if aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text > "$WORK/secrets.json" 2>/dev/null; then
  echo "Secrets: merging Secrets Manager $SECRET_ID"
else
  echo "{}" > "$WORK/secrets.json"; echo "Secrets: $SECRET_ID not found or not readable; keeping the active environment"
fi
python3 infra/deploy_env.py "$WORK/template.json" "$WORK/active.json" "$WORK/secrets.json" "$WORK/deployment.json"

# Optimistic lock: nothing may have been deployed or edited since we read the active environment.
check_lock
NOW_VERSION="$(active_version)"
if [ "$NOW_VERSION" != "$BASE_VERSION" ]; then
  echo "Refusing to deploy: the active deployment changed from version $BASE_VERSION to $NOW_VERSION while this deploy ran (someone deployed or edited the console). Re-run to build on the new environment." >&2
  exit 3
fi

NEW_VERSION="$("${LS[@]}" create-container-service-deployment --service-name "$SERVICE" --cli-input-json "file://$WORK/deployment.json" --query 'containerService.nextDeployment.version' --output text)"
if ! [[ "$NEW_VERSION" =~ ^[0-9]+$ ]]; then echo "Could not read the new deployment version." >&2; exit 1; fi
echo "Deployment version $NEW_VERSION created (image $SHA); waiting for ACTIVE (timeout ${TIMEOUT}s)"

print_logs() {
  local c
  for c in $("${LS[@]}" get-container-service-deployments --service-name "$SERVICE" --query "deployments[?version==\`$NEW_VERSION\`] | [0].containers | keys(@)" --output text 2>/dev/null || echo "app worker"); do
    echo "----- last log lines of container '$c' -----"
    "${LS[@]}" get-container-log --service-name "$SERVICE" --container-name "$c" --query 'logEvents[-40:].[createdAt,message]' --output text 2>&1 || echo "(no log available)"
  done
}

deadline=$((SECONDS + TIMEOUT)); state="UNKNOWN"
while (( SECONDS < deadline )); do
  state="$("${LS[@]}" get-container-service-deployments --service-name "$SERVICE" --query "deployments[?version==\`$NEW_VERSION\`] | [0].state" --output text)"
  case "$state" in
    ACTIVE) echo "Deployment $NEW_VERSION ($SHA) is ACTIVE"; break ;;
    FAILED|INACTIVE) echo "Deployment $NEW_VERSION ended $state; version $BASE_VERSION keeps serving." >&2; print_logs >&2; exit 1 ;;
    *) echo "  deployment $NEW_VERSION: $state"; sleep "$POLL" ;;
  esac
done
if [ "$state" != "ACTIVE" ]; then echo "Deployment $NEW_VERSION not ACTIVE after ${TIMEOUT}s (last state: $state)" >&2; print_logs >&2; exit 1; fi
{ echo "version=$SHA"; echo "deployment=$NEW_VERSION"; } >> "${GITHUB_OUTPUT:-/dev/null}"
