#!/usr/bin/env bash
# Deploy the built app to the whiteboard kiosk.
#   scripts/deploy.sh            build + rsync + restart kiosk
#   scripts/deploy.sh --no-build rsync + restart only
# Target: root@100.102.3.47, static dir /home/euidos/excalidraw served by the user unit excalidraw.service
# (python http.server on 127.0.0.1:8765); kiosk is the transient user unit excalidraw-ui.service started by
# ~/.config/autostart/excalidraw.desktop → /usr/local/bin/excalidraw.
set -euo pipefail
HOST=${WB_HOST:-root@100.102.3.47}
DIR=/home/euidos/excalidraw
cd "$(dirname "$0")/.."
if [[ "${1:-}" != "--no-build" ]]; then npm run build; fi
test -f dist/index.html
rsync -az --delete --chown=euidos:euidos dist/ "$HOST:$DIR/"
ssh "$HOST" "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/ && grep -o 'index-[A-Za-z0-9_-]*\.js' $DIR/index.html | head -1"
ssh "$HOST" 'systemctl --user -M euidos@ restart excalidraw-ui.service 2>/dev/null || systemd-run --user -M euidos@ --unit=excalidraw-ui /usr/local/bin/excalidraw'
echo "deployed; kiosk restarted"
