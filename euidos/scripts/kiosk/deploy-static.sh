#!/usr/bin/env bash
#
# ============================== LEGACY — DO NOT RUN ==============================
# This is the STATIC path that shipped `whiteboard/dist` to the wall kiosk
# (100.102.3.47), kept verbatim until the wall is cut over to the hosted board.
# `whiteboard/` no longer exists in this repo, so `npm run build` and
# `dist/index.html` below refer to a tree that is gone: as written this script
# CANNOT run, and it must not be made to. The kiosk still serves the last static
# build off its own disk and keeps the founder's board in that page's
# localStorage; the cutover is deferred and needs the founder's go (collab-plan
# phase 2). Until then: do not deploy to, reload, or relaunch that kiosk.
# To resurrect it, build an older commit of whiteboard/ in a worktree and rsync
# from there — the rest of this file (paths on the kiosk, the CDP reload, the
# --restart path) is still accurate about the HOST.
# The hosted board deploys with fleet-infra/scripts/deploy-whiteboard.sh instead.
# =================================================================================
#
# Deploy the built app to the whiteboard kiosk.
#   deploy-static.sh                 build + rsync + reload the kiosk page over CDP
#   deploy-static.sh --no-build      rsync + reload only
#   deploy-static.sh [...] --restart kill + relaunch Chromium instead of reloading (launcher flags changed)
#   deploy-static.sh [...] --force   reload even while the board looks in use (see kiosk-reload.mjs)
# Target: root@100.102.3.47, static dir /home/euidos/excalidraw served by the user unit excalidraw.service
# (python http.server on 127.0.0.1:8765). The kiosk Chromium is spawned by ~/.config/autostart/excalidraw.desktop →
# /usr/local/bin/excalidraw (directly under the session, NOT as a transient unit after a reboot), so a plain
# `systemctl restart excalidraw-ui` cannot be relied on; the default path reloads the page through the
# --remote-debugging-port instead, which keeps the founder's window and board (localStorage) intact.
set -euo pipefail
HOST=${WB_HOST:-root@100.102.3.47}
DIR=/home/euidos/excalidraw
BUILD=1; RESTART=0; FORCE=""
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --restart) RESTART=1 ;;
    --force) FORCE="--force" ;;
    *) echo "unknown flag $arg" >&2; exit 2 ;;
  esac
done
cd "$(dirname "$0")/.."
if [[ $BUILD == 1 ]]; then npm run build; fi
test -f dist/index.html
rsync -az --delete --chown=euidos:euidos dist/ "$HOST:$DIR/"
ssh "$HOST" "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/ && grep -o 'index-[A-Za-z0-9_-]*\.js' $DIR/index.html | head -1"
if [[ $RESTART == 1 ]]; then
  ssh "$HOST" 'pkill -u euidos -f "chromium.*--app=http://127.0.0.1:8765" || true; sleep 1; systemd-run --user -M euidos@ --unit=excalidraw-ui /usr/local/bin/excalidraw'
  echo "deployed; kiosk Chromium relaunched"
else
  ssh -f -N -o ExitOnForwardFailure=yes -L 9223:127.0.0.1:9222 "$HOST"
  trap 'pkill -f "L 9223:127.0.0.1:9222" || true' EXIT
  sleep 1
  node "$(dirname "$0")/kiosk-reload.mjs" $FORCE
  echo "deployed; kiosk page reloaded"
fi
