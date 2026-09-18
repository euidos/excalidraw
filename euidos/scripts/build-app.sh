#!/usr/bin/env bash
# Build the hosted euidos board app (excalidraw-app) from this fork.
#
#   euidos/scripts/build-app.sh
#
# Output: excalidraw-app/build/ — a static bundle that derives its API base and
# its socket URL from window.location.origin, so the same build serves both
# board.euidos.ai (tunnel) and the tailnet name. Deployed by
# fleet-infra/scripts (Builder C); nothing here touches a host.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# yarn 1.22.22 comes from the repo's packageManager field, not from the system
if ! command -v yarn >/dev/null 2>&1; then
  echo "==> yarn missing, enabling corepack"
  corepack enable
fi
echo "==> yarn $(yarn --version) in $repo_root"

# `yarn install` on this monorepo takes minutes; skip it when the installed tree
# already matches yarn.lock (yarn stamps node_modules/.yarn-integrity on every
# successful install). FORCE_INSTALL=1 installs anyway.
needs_install=1
if [ "${FORCE_INSTALL:-0}" != "1" ] \
   && [ -f node_modules/.yarn-integrity ] \
   && [ node_modules/.yarn-integrity -nt yarn.lock ]; then
  needs_install=0
fi

if [ "$needs_install" = "1" ]; then
  echo "==> yarn install --frozen-lockfile"
  yarn install --frozen-lockfile
else
  echo "==> dependencies current (.yarn-integrity newer than yarn.lock), skipping install"
fi

echo "==> yarn build:app"
yarn build:app

index_html="excalidraw-app/build/index.html"
if [ ! -f "$index_html" ]; then
  echo "BUILD FAILED: $index_html not produced" >&2
  exit 1
fi

bundle="$(grep -o 'assets/[A-Za-z0-9._-]*\.js' "$index_html" | head -n 1)"
echo "==> built $index_html"
echo "==> entry bundle: ${bundle:-<none found in index.html>}"
# The directory size is dominated by fonts and source maps and cannot detect a bundle regression, so the entry
# bundle is reported in BYTES (raw and gzipped) as well: that is the number a phase-over-phase comparison needs.
if [ -n "$bundle" ] && [ -f "excalidraw-app/build/$bundle" ]; then
  raw="$(stat -c%s "excalidraw-app/build/$bundle")"
  gz="$(gzip -9 -c "excalidraw-app/build/$bundle" | wc -c)"
  echo "==> entry bundle bytes: $raw raw / $gz gzipped"
fi
echo "==> build size: $(du -sh excalidraw-app/build | cut -f1)"

if grep -rqi "firebaseio\|firebasestorage\.googleapis" excalidraw-app/build/assets 2>/dev/null; then
  echo "BUILD FAILED: Firebase endpoints found in the bundle" >&2
  exit 1
fi
echo "==> no Firebase endpoints in the bundle"
