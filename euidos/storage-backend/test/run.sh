#!/usr/bin/env bash
# Integration tests against a throwaway Postgres container.
#   ./test/run.sh            # start pg, run node:test, stop pg
#   KEEP_DB=1 ./test/run.sh  # leave the container running afterwards
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER=${CONTAINER:-boards-storage-testdb}
PG_PORT=${PG_PORT:-55432}
PG_PASSWORD=${PG_PASSWORD:-test}
export PG_HOST=127.0.0.1 PG_PORT PG_USER=postgres PG_NAME=postgres PG_PASSWORD

cleanup() {
  if [ "${KEEP_DB:-0}" != "1" ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run --rm -d --name "$CONTAINER" \
  -p "127.0.0.1:${PG_PORT}:5432" \
  -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
  postgres:16-alpine >/dev/null

printf 'waiting for postgres'
for _ in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
    printf ' up\n'
    break
  fi
  printf '.'
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres -q

node --test --test-concurrency=1 test/*.test.js
