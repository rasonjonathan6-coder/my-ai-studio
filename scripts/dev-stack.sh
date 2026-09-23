#!/usr/bin/env bash
# Starts the My AI Studio stack outside docker compose, which is how this
# workspace runs it (the compose file needs POSTGRES_PASSWORD and a .env that is
# not committed). Every step is idempotent: re-running rebuilds nothing that is
# already correct and restarts the containers.
#
# Usage: scripts/dev-stack.sh [up|down|status]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER="sudo -n docker"
PG_CONTAINER=mas-pg
API_CONTAINER=mas-api
BACKEND_IMAGE=my-ai-studio-backend:jdk
SANDBOX_IMAGE=my-ai-studio-sandbox:latest
SDK_DIR=/opt/android-sdk
GRADLE_CACHE=/opt/gradle-cache

socket_gid() { stat -c '%g' /var/run/docker.sock; }

ensure_daemon() {
  if ! $DOCKER info >/dev/null 2>&1; then
    echo "starting docker daemon"
    sudo -n dockerd > /tmp/dockerd.log 2>&1 &
    for _ in $(seq 1 20); do
      $DOCKER info >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  $DOCKER info >/dev/null 2>&1 || { echo "FAILED: docker daemon unavailable"; exit 1; }
}

# The sandbox runs as uid 1000 and Gradle writes its wrapper lock into
# GRADLE_USER_HOME, so the mounted cache must be owned by that uid or every
# build fails with "Could not create parent directory for lock file".
ensure_build_dirs() {
  for d in /data/workspaces /data/storage "$GRADLE_CACHE"; do
    sudo -n mkdir -p "$d"
  done
  sudo -n chown -R 1000:1000 /data "$GRADLE_CACHE"
}

ensure_sandbox_image() {
  if ! $DOCKER image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    echo "building sandbox image"
    $DOCKER build --build-arg INSTALL_ANDROID_TOOLCHAIN=1 -t "$SANDBOX_IMAGE" "$ROOT/sandbox" || exit 1
  fi
}

ensure_backend_image() {
  echo "building backend image"
  $DOCKER build -q -f "$ROOT/backend/Dockerfile" --build-arg INSTALL_ANDROID_TOOLCHAIN=1 -t "$BACKEND_IMAGE" "$ROOT" || exit 1
}

start_postgres() {
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    $DOCKER rm -f "$PG_CONTAINER" >/dev/null 2>&1
    $DOCKER run -d --name "$PG_CONTAINER" \
      -e POSTGRES_USER=studio -e POSTGRES_PASSWORD=studiopw -e POSTGRES_DB=myaistudio \
      -v pgdata2:/var/lib/postgresql/data postgres:16-alpine >/dev/null || exit 1
  fi
  for _ in $(seq 1 30); do
    $DOCKER exec "$PG_CONTAINER" pg_isready -U studio >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FAILED: postgres did not become ready"; exit 1
}

start_backend() {
  $DOCKER rm -f "$API_CONTAINER" >/dev/null 2>&1
  $DOCKER run -d --name "$API_CONTAINER" -p 8080:8080 --link "$PG_CONTAINER":pg \
    --group-add "$(socket_gid)" \
    -e NODE_ENV=production \
    -e JWT_SECRET=dev-only-secret-change-in-production-0123456789 \
    -e DATABASE_URL=postgres://studio:studiopw@pg:5432/myaistudio \
    -e CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
    -e WORKSPACE_PATH=/data/workspaces -e STORAGE_PATH=/data/storage \
    -e SANDBOX_ENABLED=true -e SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    -e SANDBOX_EXTRA_MOUNTS="$SDK_DIR:$SDK_DIR:ro,$GRADLE_CACHE:$GRADLE_CACHE" \
    -e ANDROID_HOME="$SDK_DIR" -e ANDROID_SDK_ROOT="$SDK_DIR" \
    -e GRADLE_USER_HOME="$GRADLE_CACHE" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v /data/workspaces:/data/workspaces -v /data/storage:/data/storage \
    -v "$SDK_DIR:$SDK_DIR:ro" \
    "$BACKEND_IMAGE" >/dev/null || exit 1

  for _ in $(seq 1 40); do
    curl -sf http://127.0.0.1:8080/api/health >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FAILED: backend did not become healthy"; $DOCKER logs --tail 30 "$API_CONTAINER"; exit 1
}

case "${1:-up}" in
  up)
    ensure_daemon
    ensure_build_dirs
    ensure_sandbox_image
    ensure_backend_image
    start_postgres
    start_backend
    echo "stack up:"
    curl -s http://127.0.0.1:8080/api/health; echo
    ;;
  down)
    $DOCKER rm -f "$API_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1
    echo "containers stopped (volumes kept)"
    ;;
  status)
    $DOCKER ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
    curl -s http://127.0.0.1:8080/api/health 2>/dev/null || echo "api not reachable"
    echo
    ;;
  *)
    echo "usage: $0 [up|down|status]"; exit 2
    ;;
esac
