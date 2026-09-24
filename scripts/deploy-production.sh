#!/usr/bin/env bash
#
# Start (or restart) the My AI Studio production stack and verify it is actually
# serving traffic before reporting success.
#
#   ./scripts/deploy-production.sh
#
# Reads .env for secrets and configuration. Never prints secret values: only
# whether each one is set.
set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=0
DOMAIN="${MY_AI_STUDIO_DOMAIN:-}"
# sudo resets the environment by default, which would drop DOCKER_GID below and
# make compose fail to interpolate group_add. -E keeps only the variables this
# script exports.
COMPOSE=(sudo -E docker compose -p masprod -f docker-compose.prod.yml)

step() { printf '\n=== %s ===\n' "$1"; }

# --- Preflight --------------------------------------------------------------

step 'Preflight: environment'
if [ ! -f .env ]; then
  echo 'MISSING .env: copy .env.production.example to .env and fill it in.'
  exit 1
fi

# Read .env without exporting it, so no secret reaches this shell's environment
# (and therefore not any subprocess that dumps its environment).
env_value() { sed -n "s/^$1=//p" .env | tail -1; }

if [ -z "$DOMAIN" ]; then DOMAIN="$(env_value MY_AI_STUDIO_DOMAIN)"; fi
if [ -z "$DOMAIN" ]; then
  echo 'MISSING MY_AI_STUDIO_DOMAIN in .env. It must be the hostname users will open.'
  exit 1
fi
echo "domain: $DOMAIN"

# Required secrets: report presence, never the value.
for key in JWT_SECRET OPENROUTER_API_KEY; do
  if [ -n "$(env_value "$key")" ]; then echo "$key: configured"; else echo "$key: NOT CONFIGURED"; FAILED=1; fi
done

# The backend needs write access to the daemon socket to launch the sandbox.
# Compose requires DOCKER_GID to grant it, so derive and export it here.
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
if [ -z "$DOCKER_GID" ]; then
  echo 'Docker socket not found: cannot run the command sandbox.'
  exit 1
fi
export DOCKER_GID
echo "docker group id: $DOCKER_GID"

if ! sudo docker info >/dev/null 2>&1; then
  echo 'Docker daemon unreachable: start it before deploying.'
  exit 1
fi

# Project data lives in a host directory because the sandbox is a sibling
# container: the daemon resolves bind-mount sources on the host, so the backend
# needs to know the host path (SANDBOX_WORKSPACE_HOST_PATH), and an opaque named
# volume could not provide one. Configurable so it can point at a larger disk.
DATA_ROOT="$(env_value DATA_ROOT)"
if [ -z "$DATA_ROOT" ]; then
  echo 'MISSING DATA_ROOT in .env (host directory for project data).'
  exit 1
fi
sudo mkdir -p "$DATA_ROOT/workspaces" "$DATA_ROOT/storage"
# The container runs as uid/gid 1000; without this the workspace is unwritable.
sudo chown -R 1000:1000 "$DATA_ROOT"
export DATA_ROOT
echo "data root: $DATA_ROOT"

# TLS can be terminated here (self-signed until DNS resolves) or upstream by the
# platform. That decides which URL the checks below must use.
CADDYFILE="$(env_value CADDYFILE)"
if [ "$CADDYFILE" = "deploy/Caddyfile.public" ]; then
  SCHEME=http
  PORT="$(env_value WEB_HTTP_PORT)"; PORT="${PORT:-80}"
else
  SCHEME=https
  PORT="$(env_value WEB_HTTPS_PORT)"; PORT="${PORT:-443}"
fi
if [ "$PORT" = 80 ] || [ "$PORT" = 443 ]; then PARTIAL=""; else PARTIAL=":$PORT"; fi
BASE="${SCHEME}://localhost${PARTIAL}"
echo "checking against: $BASE"

# curl needs -k only when this host terminates TLS itself with a certificate that
# may be self-signed. Against an upstream edge the certificate is trusted.
CURL=(curl -s)
if [ "$SCHEME" = https ]; then CURL+=(-k); fi

# --- Build and start --------------------------------------------------------

step 'Building images'
# The sandbox image is built on the host, not as a compose service: the backend
# launches it by name via the daemon socket.
if ! sudo docker build -f sandbox/Dockerfile -t my-ai-studio-sandbox:latest . ; then
  echo 'FAILED: sandbox image build'
  exit 1
fi
if ! "${COMPOSE[@]}" build backend web; then
  echo 'FAILED: backend/web image build'
  exit 1
fi
if ! "${COMPOSE[@]}" up -d postgres backend web; then
  echo 'FAILED: compose up'
  exit 1
fi

step 'Waiting for health'
HEALTHY=0
for _ in $(seq 1 40); do
  if "${CURL[@]}" -f "$BASE/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 3
done
if [ "$HEALTHY" != 1 ]; then
  echo "FAILED: $BASE/api/health did not answer within 120s"
  "${COMPOSE[@]}" logs backend --tail 30
  exit 1
fi
echo 'health: PASS'

# --- Verification -----------------------------------------------------------

step 'Verifying public surface'
check() {
  local label="$1" url="$2" expect="$3"
  local code
  code="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$url")"
  if [ "$code" = "$expect" ]; then
    printf 'PASS  %s (%s)\n' "$label" "$code"
  else
    printf 'FAIL  %s (got %s, expected %s)\n' "$label" "$code" "$expect"
    FAILED=1
  fi
}
check 'frontend' "$BASE/" 200
check 'API health' "$BASE/api/health" 200
check 'unauthenticated API is rejected' "$BASE/api/projects" 401

# The execution backend must be the sandbox. If this reports "host" the server is
# running untrusted commands in its own process; if "unavailable" commands will
# fail at execution time.
step 'Verifying command execution backend'
LOG="$("${COMPOSE[@]}" logs backend 2>&1 | grep -o '"executionBackend":"[a-z]*"' | tail -1)"
echo "backend log reports: ${LOG:-<none>}"
case "$LOG" in
  *'"executionBackend":"docker"'*) echo 'PASS  sandboxed command execution' ;;
  *) echo 'FAIL  commands are not sandboxed'; FAILED=1 ;;
esac

# A frontend bundle must never contain a secret. This greps the bytes actually
# served over the network, not the build directory.
step 'Scanning the served frontend bundle for secrets'
BUNDLE="$("${CURL[@]}" "$BASE/" | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | sort -u)"
HIT=0
for asset in $BUNDLE; do
  if "${CURL[@]}" "$BASE$asset" | grep -aoE 'sk-or-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|postgres://[^"'"'"' ]{10,}'; then
    HIT=1
  fi
done
if [ "$HIT" = 0 ]; then echo 'PASS  no secret in the served bundle'; else echo 'FAIL  secret found in the served bundle'; FAILED=1; fi

# --- Report -----------------------------------------------------------------

step 'Result'
if [ "$FAILED" = 0 ]; then
  echo 'PRODUCTION DEPLOYMENT: PASS'
  echo
  echo "Public URL: ${SCHEME}://$DOMAIN/"
  exit 0
fi
echo 'PRODUCTION DEPLOYMENT: FAIL (see FAIL lines above)'
exit 1
