#!/usr/bin/env bash
# Post-deploy smoke test. Usage: infra/smoke.sh https://app.example.com
# Fails unless /api/health answers ok:true AND reports the deployed git SHA (EXPECTED_VERSION, default: this checkout's
# `git rev-parse --short=7 HEAD`, the value deploy.sh bakes into the image). The old version still serving is a failure.
set -euo pipefail
URL="${1:?url}"
EXPECTED="${EXPECTED_VERSION:-$(git rev-parse --short=7 HEAD)}"
# Lightsail reports the new deployment ACTIVE a little before its load balancer stops serving the old one (run of
# 23 Oct 2026: ACTIVE, then /api/health still answered the previous SHA). Poll until the expected version answers,
# up to SMOKE_WAIT_SECONDS (default 180); every other check fails at once.
WAIT="${SMOKE_WAIT_SECONDS:-180}"; deadline=$((SECONDS + WAIT)); rc=1
while :; do
  HEALTH="$(curl -fsS --retry 3 --retry-delay 5 "$URL/api/health")" || { echo "health FAILED: no 2xx answer from $URL/api/health"; exit 1; }
  set +e
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
    print(f"version not yet {expected!r}: got {h.get('version')!r}")
    sys.exit(3)
print(f"health OK: version {expected}, mode {h.get('mode')}, deps {h.get('deps')}")
EOF
  rc=$?; set -e
  [ "$rc" -eq 0 ] && break
  [ "$rc" -ne 3 ] && exit 1
  (( SECONDS < deadline )) || { echo "version FAILED: expected '$EXPECTED' not served after ${WAIT}s (is the new deployment ACTIVE?)"; exit 1; }
  sleep 10
done
curl -fsS -o /dev/null -w "home %{http_code}\n" "$URL/"
curl -fsS -I "$URL/" | grep -i "strict-transport-security" > /dev/null || { echo "HSTS FAILED"; exit 1; }; echo "HSTS OK"
