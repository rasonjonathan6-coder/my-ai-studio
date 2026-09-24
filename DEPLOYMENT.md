# Deployment

The backend is the only stateful component. It needs a PostgreSQL database, a
persistent disk for workspaces and artifacts, and - for the full experience - a
Docker daemon so agent commands run sandboxed.

## Topology

| Piece | Where | Notes |
| --- | --- | --- |
| Frontend | Cloudflare Pages (or any static host) | `npm run build`, output `frontend/dist` |
| Backend | A VM with Docker (Oracle Cloud Always Free works) | this document |
| Database | Supabase, or PostgreSQL on the same VM | see `SUPABASE_SETUP.md` |
| CI | GitHub Actions | see `GITHUB_ACTIONS.md` |

The frontend is a static bundle. It reaches the backend through `VITE_API_URL`,
so it can live on a different host from the API. Set `CORS_ORIGINS` on the
backend to the exact frontend origin: the API is cookie-authenticated, so a
wildcard origin is not appropriate in production.

The backend reads its environment from the repository-root `.env` (the npm
scripts pass `--env-file-if-exists=../.env`).

## Option A - Docker Compose (production stack)

`docker-compose.prod.yml` runs the whole system - database, backend, TLS-
terminating web server and the command sandbox - from one file. Prefer this over
the development `docker-compose.yml` for anything internet-facing.

```bash
git clone https://github.com/<owner>/<repo>.git my-ai-studio
cd my-ai-studio

cp .env.production.example .env
# Fill in DATABASE_URL, JWT_SECRET and MY_AI_STUDIO_CREDENTIAL_KEY at minimum.
# Generate each with: openssl rand -hex 32
# MY_AI_STUDIO_CREDENTIAL_KEY encrypts the stored GitHub credential. Keep it
# separate from JWT_SECRET so rotating sessions does not lock the credential out.

./scripts/deploy-production.sh
```

The script builds the images, starts the stack, and then verifies it before
reporting: it checks that the frontend, the API and the 401 on an unauthenticated
request all answer, that the backend really resolved the Docker sandbox as its
execution backend, and that no secret is present in the bytes served to the
browser. It prints `PRODUCTION DEPLOYMENT: PASS` only if all of that held.

Three settings in `.env` drive the deployment and have no safe default:

| Variable | Meaning |
| --- | --- |
| `MY_AI_STUDIO_DOMAIN` | The hostname users open. Must resolve to this host for Let's Encrypt. |
| `DATA_ROOT` | Host directory for project workspaces and artifacts. Must be writable by uid 1000. |
| `DOCKER_GID` | Group id owning `/var/run/docker.sock`. The script derives it (`stat -c %g`); compose needs it to grant the backend access. |

### Sandbox configuration

The sandbox is a sibling container, which drives two settings that are easy to
get wrong:

1. The backend must be able to open the Docker socket. The socket is owned by
   `root:<docker gid>` with mode `0660` while the backend runs as an
   unprivileged uid 1000, so `docker-compose.prod.yml` passes
   `group_add: '${DOCKER_GID}'`. Without it every command fails with
   "permission denied" and the startup log reports `executionBackend` as
   `unavailable`, not `docker`.
2. The daemon resolves bind-mount sources on the *host*, not inside the backend
   container. `WORKSPACE_PATH` (`/data/workspaces`) does not exist on the host, so
   Docker would silently mount an empty directory and every build would fail with
   a missing `package.json`. `SANDBOX_WORKSPACE_HOST_PATH` supplies the host path
   of the same directory, and the workspaces mount is a bind mount rather than a
   named volume for this reason.

Mounting the Docker socket grants effective root on the host, so only do this on
a machine dedicated to this service.

In production the backend refuses to start unless `SANDBOX_ENABLED=true`, and it
refuses to *fall back* to host execution if the sandbox turns out to be
unusable at run time (image missing, daemon down). Both exist because the host
backend runs commands in the server process, which can read the environment file
and every provider key in it. `ALLOW_HOST_EXECUTION_IN_PRODUCTION=true` overrides
both, and is only appropriate for a trusted single-tenant host.

### TLS terminated by a platform

If something in front of the container already serves HTTPS and forwards plain
HTTP to it - a platform proxy or a managed load balancer - set:

```bash
CADDYFILE=deploy/Caddyfile.public
```

This serves plain HTTP on the container port and does not redirect to HTTPS,
which the default `deploy/Caddyfile` does. The browser still sees HTTPS from the
edge, so the session cookie stays `Secure`.

## Option A-bis - direct Compose (development topology)

Prerequisites: a Linux VM, Docker Engine, and a clone of this repository.

```bash
git clone https://github.com/<owner>/<repo>.git my-ai-studio
cd my-ai-studio

cp .env.production.example .env
# Fill in DATABASE_URL, JWT_SECRET and MY_AI_STUDIO_CREDENTIAL_KEY at minimum.
# Generate each with: openssl rand -hex 32
# MY_AI_STUDIO_CREDENTIAL_KEY encrypts the stored GitHub credential. Keep it
# separate from JWT_SECRET so rotating sessions does not lock the credential out.

# Workspaces must be writable by the runtime user (uid 1000 in the images).
mkdir -p /data/workspaces /data/storage
sudo chown -R 1000:1000 /data/workspaces /data/storage

docker compose up -d --build
docker compose logs -f backend
```

This topology uses a named volume for the workspace and leaves the Docker socket
commented out, so it runs the host backend. That is fine for development: the
host backend needs no socket and no `SANDBOX_WORKSPACE_HOST_PATH`. For anything
reachable from the internet use the production stack above, which sandboxes
commands.

Verify:

```bash
curl -s http://127.0.0.1:8080/api/health
bash scripts/smoke.sh
```

### Enabling the sandbox

`SANDBOX_ENABLED=true` makes agent commands run in a throwaway container, which
requires the backend to reach the Docker daemon:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Mounting the Docker socket grants effective root on the host, so only do this on
a machine dedicated to this service. `docker-compose.yml` ships with the socket
commented out, so enabling it is a deliberate choice.

## Option B - systemd without Compose

```bash
sudo useradd -r -u 1000 -m mas || true
sudo mkdir -p /opt/my-ai-studio /data/workspaces /data/storage
sudo chown -R 1000:1000 /opt/my-ai-studio /data/workspaces /data/storage

cd /opt/my-ai-studio
sudo -u mas npm ci
sudo -u mas npm run build
sudo -u mas npm run migrate --workspace backend
```

`/etc/systemd/system/my-ai-studio.service`:

```ini
[Unit]
Description=My AI Studio backend
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=mas
WorkingDirectory=/opt/my-ai-studio/backend
EnvironmentFile=/opt/my-ai-studio/.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
# Give in-flight work time to finish on SIGTERM.
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now my-ai-studio
journalctl -u my-ai-studio -f
```

The backend handles `SIGTERM` and `SIGINT` by closing the HTTP server, the
WebSocket connections and the database pool, so a restart does not leave work
half-written.

## Reverse proxy and HTTPS

Caddy is the shortest path to TLS:

```
your-domain.example {
    encode gzip
    reverse_proxy /api/* 127.0.0.1:8080
    reverse_proxy /ws/*  127.0.0.1:8080
}
```

nginx equivalent - WebSocket needs the upgrade headers forwarded, and builds and
agent runs need a long read timeout:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    client_max_body_size 4m;    # keep in step with MAX_REQUEST_BODY
}
```

## Firewall

Expose only 80 and 443. The API port and PostgreSQL must not be reachable from
the internet.

```bash
sudo iptables -I INPUT -p tcp --dport 8080 -j DROP
sudo iptables -I INPUT -p tcp --dport 5432 -j DROP
```

On Oracle Cloud also open 80/443 in the VCN security list: the instance firewall
alone is not enough, and the Ubuntu images reject everything but SSH by default.

## Logs

The backend writes structured logs to stdout, with secrets redacted before they
are written.

```bash
docker compose logs -f --tail=200 backend   # Compose
journalctl -u my-ai-studio -f               # systemd
```

## Backups

The database holds users, projects and run history; the workspace disk holds the
actual files. Back up both, or accept losing the second.

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom -f "backup-$(date +%F).dump"
tar czf "artifacts-$(date +%F).tar.gz" -C /data workspaces storage
```

Restore:

```bash
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backup-2026-01-01.dump
```

A cron entry makes it automatic:

```cron
17 3 * * * pg_dump "$DATABASE_URL" --no-owner --format=custom -f /backups/db-$(date +\%F).dump && find /backups -name 'db-*.dump' -mtime +14 -delete
```

**This is a procedure, not a running service.** This repository configures no
backup job and nothing on the development machine runs one. Treat "backups are
active" as false until you have installed and verified the cron entry yourself.

## Updating a deployment

```bash
cd /opt/my-ai-studio
git pull
npm ci
npm run build
npm run migrate --workspace backend
sudo systemctl restart my-ai-studio
curl -s http://127.0.0.1:8080/api/health
```

Migrations are tracked in `schema_migrations`, so re-running `npm run migrate` is
safe.

## Before going live

See `PRODUCTION_CHECKLIST.md`. The short version: a real `JWT_SECRET`, a real
`MY_AI_STUDIO_CREDENTIAL_KEY`, a real `DATABASE_URL` with TLS, `CORS_ORIGINS`
pinned to your domain, HTTPS terminated in front, and the API port unreachable
from the internet.
