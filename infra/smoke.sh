#!/usr/bin/env bash
# Post-deploy smoke test. Usage: infra/smoke.sh https://app.example.com [expected-version]
# Asserts /api/health answers ok:true AND reports the version just deployed (default: `git describe --tags --always`,
# the same value deploy.sh writes into APP_VERSION), so a smoke test can never pass against the previous deployment.
set -euo pipefail
URL="${1:?url}"
EXPECTED="${2:-$(git describe --tags --always)}"
HEALTH="$(curl -fsS --retry 3 --retry-delay 5 "$URL/api/health")"
python3 - "$EXPECTED" "$HEALTH" <<'EOF'
import json, sys
expected, raw = sys.argv[1], sys.argv[2]
try:
    h = json.loads(raw)
except ValueError:
    sys.exit("health: response is not JSON")
if h.get("ok") is not True:
    sys.exit(f"health: ok is {h.get('ok')!r}, deps={h.get('deps')!r}")
if h.get("version") != expected:
    sys.exit(f"health: version {h.get('version')!r} != expected {expected!r} (is the new deployment ACTIVE?)")
print(f"health OK, version {expected}, modes={h.get('modes')}, deps={h.get('deps')}")
EOF
curl -fsS -o /dev/null -w "home %{http_code}\n" "$URL/"
curl -fsS -I "$URL/" | grep -qi "strict-transport-security" && echo "HSTS OK"
