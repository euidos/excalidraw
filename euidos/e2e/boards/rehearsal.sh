#!/usr/bin/env bash
# Bring the boards acceptance stack up (or down) on THIS machine.
#
#   euidos/e2e/boards/rehearsal.sh up     # build image, start stack, wait healthy
#   euidos/e2e/boards/rehearsal.sh down   # stop and delete it, volume included
#
# It runs the REAL stack from fleet-infra/stacks/euidos-internal — same nginx
# config, same storage image, same postgres, same socket relay — under a
# throwaway compose project (`boards-e2e`), a throwaway password and a fresh
# volume. Nothing is published on 0.0.0.0 and nothing touches euidos-internal or
# the wall kiosk.
#
# The document root is `excalidraw-app/build/`, so BUILD FIRST
# (`euidos/scripts/build-app.sh`) or the suite tests a stale bundle.
#
# TWO REHEARSAL-ONLY DEVIATIONS, both deliberate, both named here so nobody
# mistakes them for how the host runs:
#
#  1. The tailnet listener is published on 127.0.0.1:18099 instead of 18090, and
#     there is no Tailscale Serve in front of it. That is the point: nginx's
#     :8081 block passes a client-supplied `Tailscale-User-Login` through, so
#     one origin can be driven as alice, as bob, and (no header) as the wall.
#     On the real host Serve sets that header itself and strips client copies.
#
#  2. nginx's `proxy_set_header Host $host;` becomes `$http_host` in a PATCHED
#     COPY of the config (the repo's file is not modified). `$host` drops the
#     port, so on a non-standard port the backend compares `Origin:
#     http://127.0.0.1:18099` against `Host: 127.0.0.1`, decides the write is
#     cross-site and answers 403 — every create/rename/delete from the app
#     fails. Production never hits this because both front doors are on 443 and
#     carry no port, but any future origin on a port would. Worth fixing
#     upstream in fleet-infra (`$http_host` is identical to `$host` whenever no
#     port is present); until then the rehearsal patches it, because otherwise
#     the suite would be testing nginx's port handling instead of the app.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
stack_dir="${FLEET_INFRA:-$(cd "$repo_root/../fleet-infra" && pwd)}/stacks/euidos-internal"
project=boards-e2e
work="${TMPDIR:-/tmp}/$project"
port="${BOARDS_PORT:-18099}"

compose() {
  docker compose -p "$project" --env-file "$work/stack.env" \
    -f "$stack_dir/compose.yaml" -f "$work/override.yaml" "$@"
}

case "${1:-up}" in
  down)
    if [ -f "$work/stack.env" ]; then
      compose down -v
    else
      docker compose -p "$project" down -v || true
    fi
    rm -rf "$work"
    echo "==> $project torn down"
    ;;
  up)
    [ -f "$repo_root/excalidraw-app/build/index.html" ] || {
      echo "no excalidraw-app/build — run euidos/scripts/build-app.sh first" >&2
      exit 1
    }
    mkdir -p "$work"

    echo "==> building euidos/boards-storage:e2e-boards"
    docker build -q -t euidos/boards-storage:e2e-boards "$repo_root/euidos/storage-backend" >/dev/null

    # deviation 2 — see the header
    sed 's/proxy_set_header Host \$host;/proxy_set_header Host $http_host;/' \
      "$stack_dir/nginx.conf" > "$work/nginx.conf"

    cat > "$work/stack.env" <<EOF
STACK_NAME=$project
WHITEBOARD_ROOT=$repo_root/excalidraw-app/build
STORAGE_TAG=e2e-boards
BOARDS_PG_NAME=boards
BOARDS_PG_USER=boards
BOARDS_PG_PASSWORD=$(openssl rand -hex 24)
ACCESS_AUD=rehearsal-not-a-real-aud
ACCESS_TEAM_DOMAIN=euidos.cloudflareaccess.com
FILE_UPLOAD_MAX_BYTES=4194304
EOF

    cat > "$work/override.yaml" <<EOF
services:
  web:
    container_name: $project-web
    ports: !override
      - "127.0.0.1:$port:8081"
    volumes: !override
      - $repo_root/excalidraw-app/build:/usr/share/nginx/html:ro
      - $work/nginx.conf:/etc/nginx/conf.d/default.conf:ro
  storage:
    container_name: $project-storage
  room:
    container_name: $project-room
  db:
    container_name: $project-db
EOF

    compose up -d db storage room web
    for _ in $(seq 1 30); do
      if curl -sf "http://127.0.0.1:$port/api/health" >/dev/null; then
        echo "==> http://127.0.0.1:$port healthy"
        exit 0
      fi
      sleep 1
    done
    echo "stack did not become healthy" >&2
    compose logs --tail 40 storage web >&2
    exit 1
    ;;
  *)
    echo "usage: rehearsal.sh [up|down]" >&2
    exit 2
    ;;
esac
