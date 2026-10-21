#!/usr/bin/env bash
# Post-deploy smoke test. Usage: infra/smoke.sh https://app.example.com
set -euo pipefail
URL="${1:?url}"
curl -fsS "$URL/api/health" | grep -q '"ok":true' && echo "health OK"
curl -fsS -o /dev/null -w "home %{http_code}\n" "$URL/"
curl -fsS -I "$URL/" | grep -qi "strict-transport-security" && echo "HSTS OK"
