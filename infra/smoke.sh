#!/usr/bin/env bash
# Post-deploy smoke test. Usage: infra/smoke.sh https://app.example.com
# Fails unless /api/health answers ok:true AND reports the deployed git SHA (EXPECTED_VERSION, default: this checkout's
# `git rev-parse --short=7 HEAD`, the value deploy.sh bakes into the image). The old version still serving is a failure.
set -euo pipefail
URL="${1:?url}"
EXPECTED="${EXPECTED_VERSION:-$(git rev-parse --short=7 HEAD)}"
HEALTH="$(curl -fsS --retry 3 --retry-delay 5 "$URL/api/health")" || { echo "health FAILED: no 2xx answer from $URL/api/health"; exit 1; }
python3 - "$EXPECTED" "$HEALTH" <<'EOF'
import json, sys
expected, raw = sys.argv[1], sys.argv[2]
try:
    h = json.loads(raw)
except ValueError:
    sys.exit("health FAILED: response is not JSON")
if h.get("ok") is not True:
    sys.exit(f"health FAILED: ok={h.get('ok')!r} deps={h.get('deps')!r}")
if h.get("version") != expected:
    sys.exit(f"version FAILED: expected {expected!r}, got {h.get('version')!r} (is the new deployment ACTIVE?)")
print(f"health OK: version {expected}, mode {h.get('mode')}, deps {h.get('deps')}")
EOF
curl -fsS -o /dev/null -w "home %{http_code}\n" "$URL/"
curl -fsS -I "$URL/" | grep -qi "strict-transport-security" || { echo "HSTS FAILED"; exit 1; }; echo "HSTS OK"
