#!/usr/bin/env bash
# Upload the web app's source maps to Sentry for the release being deployed. Usage: infra/sentry-sourcemaps.sh
# Skips (exit 0) when SENTRY_AUTH_TOKEN or SENTRY_PROJECT is not set, so CI works before Sentry is configured.
# The release name is `git describe --tags --always`, the same value deploy.sh writes into APP_VERSION and the SDKs send.
# Server stack traces need no upload: the API and worker run with --enable-source-maps (infra/Dockerfile).
set -euo pipefail
if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then echo "SENTRY_AUTH_TOKEN not set: skipping source map upload"; exit 0; fi
if [ -z "${SENTRY_PROJECT:-}" ]; then echo "SENTRY_PROJECT not set: skipping source map upload"; exit 0; fi
export SENTRY_ORG="${SENTRY_ORG:-24h-logistics}"
RELEASE="$(git describe --tags --always)"
pnpm install --frozen-lockfile
pnpm --filter "./packages/**" build
pnpm --filter web build   # vite emits "hidden" source maps next to the bundles
# sentry-cli (FSL-1.1-MIT) runs as a pinned one-off CI tool: it is not a project dependency and never ships in the image.
CLI=(pnpm dlx @sentry/cli@3.8.0)
"${CLI[@]}" releases new "$RELEASE"
"${CLI[@]}" sourcemaps upload --release "$RELEASE" --url-prefix "~/assets" apps/web/dist/assets
"${CLI[@]}" releases finalize "$RELEASE"
echo "Source maps uploaded for release $RELEASE ($SENTRY_ORG/$SENTRY_PROJECT)"
