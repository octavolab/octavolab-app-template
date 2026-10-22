#!/usr/bin/env bash
# Post-deploy smoke test. Usage: infra/smoke.sh https://app.example.com
set -euo pipefail
URL="${1:?url}"
HEALTH="$(curl -fsS "$URL/api/health")"
echo "$HEALTH" | grep -q '"ok":true' || { echo "health FAILED: $HEALTH"; exit 1; }; echo "health OK"
# With EXPECTED_VERSION set (CI passes the deployed commit), the smoke test fails if the old version is still serving.
if [ -n "${EXPECTED_VERSION:-}" ]; then
  echo "$HEALTH" | grep -q "\"version\":\"$EXPECTED_VERSION\"" || { echo "version FAILED: expected $EXPECTED_VERSION, got $HEALTH"; exit 1; }
  echo "version $EXPECTED_VERSION OK"
fi
curl -fsS -o /dev/null -w "home %{http_code}\n" "$URL/"
curl -fsS -I "$URL/" | grep -qi "strict-transport-security" || { echo "HSTS FAILED"; exit 1; }; echo "HSTS OK"
