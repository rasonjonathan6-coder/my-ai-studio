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

# Local development credentials. This script must not carry a working password
# or JWT secret in a tracked file: a scanner (and any reader of the repository)
# would treat them as real secrets, and anyone who copied the repo would share
# them. Instead we generate random values on first run and keep them in a
# gitignored file so containers keep the same values across restarts.
DEV_CRED_FILE="$ROOT/.dev-credentials"

load_dev_credentials() {
  if [ -f "$DEV_CRED_FILE" ]; then
    PG_PASSWORD="$(sed -n 's/^PG_PASSWORD=//p' "$DEV_CRED_FILE" | head -1)"
    JWT_SECRET="$(sed -n 's/^JWT_SECRET=//p' "$DEV_CRED_FILE" | head -1)"
  elif $DOCKER ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    # The data volume already exists, so its password is authoritative. Adopting
    # it keeps `up` idempotent; generating a fresh one here would leave the
    # backend unable to authenticate against an unchanged database.
    PG_PASSWORD="$($DOCKER inspect "$PG_CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
      | sed -n 's/^POSTGRES_PASSWORD=//p' | head -1)"
    JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    umask 077
    printf 'PG_PASSWORD=%s\nJWT_SECRET=%s\n' "$PG_PASSWORD" "$JWT_SECRET" > "$DEV_CRED_FILE"
    echo "adopted the existing postgres password; wrote .dev-credentials (gitignored)"
  else
    umask 077
    {
      printf 'PG_PASSWORD=%s\n' "$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
      printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    } > "$DEV_CRED_FILE"
    echo "generated local development credentials in .dev-credentials (gitignored)"
  fi
  [ -n "$PG_PASSWORD" ] && [ -n "$JWT_SECRET" ] || { echo "FAILED: local credentials are unavailable"; exit 1; }
}

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
      -e POSTGRES_USER=studio -e "POSTGRES_PASSWORD=$PG_PASSWORD" -e POSTGRES_DB=myaistudio \
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
  # Pass OpenRouter credentials only when .env provides them. The value is read
  # into a shell variable and handed to docker without being echoed, so it never
  # reaches the terminal, this script's output, or any log.
  local or_args=()
  if [ -f "$ROOT/.env" ]; then
    local or_key or_model
    or_key="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$ROOT/.env" | head -1)"
    or_model="$(sed -n 's/^OPENROUTER_MODEL=//p' "$ROOT/.env" | head -1)"
    [ -n "$or_key" ] && or_args+=(-e "OPENROUTER_API_KEY=$or_key")
    [ -n "$or_model" ] && or_args+=(-e "OPENROUTER_MODEL=$or_model")
  fi
  $DOCKER run -d --name "$API_CONTAINER" -p 8080:8080 --link "$PG_CONTAINER":pg \
    --group-add "$(socket_gid)" \
    -e NODE_ENV=production \
    -e "JWT_SECRET=$JWT_SECRET" \
    -e "DATABASE_URL=postgres://studio:$PG_PASSWORD@pg:5432/myaistudio" \
    -e CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 \
    -e WORKSPACE_PATH=/data/workspaces -e STORAGE_PATH=/data/storage \
    -e SANDBOX_ENABLED=true -e SANDBOX_IMAGE="$SANDBOX_IMAGE" \
    -e SANDBOX_EXTRA_MOUNTS="$SDK_DIR:$SDK_DIR:ro,$GRADLE_CACHE:$GRADLE_CACHE" \
    -e ANDROID_HOME="$SDK_DIR" -e ANDROID_SDK_ROOT="$SDK_DIR" \
    -e GRADLE_USER_HOME="$GRADLE_CACHE" \
    "${or_args[@]}" \
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
    load_dev_credentials
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
