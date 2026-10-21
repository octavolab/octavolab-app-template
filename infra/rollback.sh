#!/usr/bin/env bash
# Re-activate a previous Lightsail deployment version. Usage: infra/rollback.sh <service> <version-number>
set -euo pipefail
SERVICE="${1:?service}"; VER="${2:?version}"; REGION="${AWS_REGION:-eu-west-2}"
aws lightsail get-container-service-deployments --service-name "$SERVICE" --region "$REGION" --query "deployments[?version==\`$VER\`]" --output json > /tmp/rb.json
echo "Rolling back $SERVICE to version $VER"
python3 - <<'EOF'
import json; d=json.load(open('/tmp/rb.json'))[0]; json.dump({"containers":d["containers"],"publicEndpoint":d["publicEndpoint"]},open('/tmp/rb.deploy.json','w'))
EOF
aws lightsail create-container-service-deployment --service-name "$SERVICE" --region "$REGION" --cli-input-json file:///tmp/rb.deploy.json
