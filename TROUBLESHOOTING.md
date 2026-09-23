# Troubleshooting

Each entry is a real failure mode of this system, the actual cause, and how to
confirm the fix. If a symptom here does not match what you see, trust the log
line over the table.

## Startup

### `Error: JWT_SECRET must be set to at least 32 characters in production`

`NODE_ENV=production` requires a real session secret. Generate one and put it in
`.env`:

```bash
openssl rand -hex 32
```

### `DATABASE_URL is not configured on the server`

The API refused to serve a request because there is no database. Set
`DATABASE_URL` in the repository-root `.env`. The npm scripts read that file
(`--env-file-if-exists=../.env`), so a `.env` inside `backend/` is not picked up.

### `EADDRINUSE :8080`

Something already holds the port. Find the exact process before killing it:

```bash
ss -ltnp | grep :8080
```

Then stop that PID, or set a different `PORT`.

### The container exits immediately

Read its logs - startup failures always log a reason:

```bash
docker compose logs --tail=100 backend
```

The two usual causes are a `DATABASE_URL` that points at `localhost` (inside a
container that is the container itself, not the host - use the service name) and
a workspace path the runtime user cannot write.

## Database

### `no pg_hba.conf entry for host ... SSL off`

Managed PostgreSQL needs TLS. Append `sslmode=require` to `DATABASE_URL` and set
`DATABASE_SSL=true`.

### `password authentication failed`

Either the password is wrong or it contains URL-reserved characters
(`@ : / ? #`). Percent-encode them, do not quote them.

### `prepared statement "s0" already exists`

You are on a connection pooler in **transaction** mode (Supabase port 6543),
which does not preserve session state across statements. Use the direct
connection or the pooler in **session** mode.

### `/api/system/status` shows `postgres: error`

The probe is a real connection attempt. Check that the host is reachable from
where the backend runs:

```bash
psql "$DATABASE_URL" -c 'select 1'
```

A `ENOTFOUND` means DNS or a wrong hostname; a timeout means a firewall or
network restriction.

## Authentication

### Login succeeds but the next request is unauthenticated

The browser is not sending the session cookie. Two causes:

1. **Cross-site without `SameSite=None`.** If the frontend and API are on
   different sites, set `SESSION_COOKIE_SAMESITE=none`. It forces `Secure`, so
   both sides must be HTTPS.
2. **CORS origin not allowed.** The backend logs `cors origin rejected` with the
   origin it saw. Add that exact origin to `CORS_ORIGINS` - scheme included, no
   trailing slash.

### `401` on a request that works from `curl`

`curl` does not enforce `SameSite` or `Secure` the way a browser does, so it can
succeed where the browser fails. Test in the browser's network tab, and look at
whether the `Set-Cookie` response header was actually accepted.

## Terminal and agent

### Every command returns `exit code 127` with `not found`

The binary is not on `PATH` inside the sandbox. The sandbox image contains only
what its `Dockerfile` installs; the host's toolchain is not visible unless you
mount it via `SANDBOX_EXTRA_MOUNTS`. Check what is actually available:

```bash
docker run --rm my-ai-studio-sandbox:latest sh -c 'command -v node gradle java'
```

### `./gradlew: not found`

Two distinct causes:

1. The project has no Gradle wrapper. Create the project from an Android
   template so the wrapper is generated.
2. **Docker-outside-of-Docker path mismatch.** The sandbox mounts the host path
   from the backend's own view of the filesystem. If the backend is itself in a
   container with `/data/workspaces` mounted from the host, the sandbox needs the
   *host* path. `SANDBOX_EXTRA_MOUNTS` and the workspace mount must use paths
   that are valid for the Docker daemon, not paths that are only valid inside
   the backend container. This is the single most common sandbox failure.

### The agent run fails with `rate_limited: daily free-model quota exhausted`

Not a bug. `openrouter/free` allows a fixed number of requests per day and the
allowance is spent. The message includes the reset timestamp from OpenRouter's
`X-RateLimit-Reset` header. The client deliberately does not retry a daily quota
inside the run, because retrying cannot succeed before the reset. Wait for the
reset, add credits, or change `OPENROUTER_MODEL`. See `OPENROUTER_SETUP.md`.

### The agent replies `not_configured`

`OPENROUTER_API_KEY` is unset. This is reported honestly rather than faked. Set
the key and restart; `/api/health` will then show `openrouter: "configured"`.
See `OPENROUTER_SETUP.md`.

### `MAX_FIX_ATTEMPTS_REACHED`

The loop tried `MAX_FIX_ATTEMPTS` times and could not make the build pass. The
last failure log is attached to the message. Read it - the model's fix attempts
are in the run history too. Raising the limit is rarely the answer; a broken
toolchain or a missing dependency is.

### The agent run never finishes

Check the job queue in `/api/system/status` (`jobs.active`, `jobs.pending`,
`jobs.max`). Runs are capped by `AGENT_TIMEOUT_MS` and builds by
`BUILD_TIMEOUT_MS`; a run that exceeds them is terminated and marked as a
timeout rather than hanging forever.

## Android build

### `SDK location not found. Define a valid SDK location with ANDROID_HOME`

`ANDROID_HOME` (and `ANDROID_SDK_ROOT`) did not reach Gradle. Build and test
share `toolchainEnv()` in `commandRunner.ts`; if you add a new call path, pass
that environment or Gradle will not find the SDK. Symptoms: works from your
shell, fails through the API.

### `Failed to install the following Android SDK packages ... build-tools;34.0.0`

The component is missing. Install it:

```bash
sdkmanager --install "platforms;android-34" "build-tools;34.0.0" "platform-tools"
yes | sdkmanager --licenses
```

### Gradle runs out of memory

The default heap is too small for the Android plugin. Raise it in
`gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
```

On a 1 GB VM this will still fail - build on a bigger machine, or use the GitHub
Actions APK workflow instead of building on the server.

### The build reports success but no APK exists

The backend verifies the file on disk before reporting success precisely because
this happens with stale task outputs. Check:

```bash
find . -path '*/build/outputs/apk/debug/*.apk' -type f
```

If it is empty, the failure is real regardless of Gradle's exit code.

### `Execution failed for task ':app:compileDebugKotlin'`

A compile error, not an environment problem. The real file and line are in the
log above the summary line; the agent reads that log and edits the file, which is
what the fix loop is for.

## APK inspection

### `apksigner` reports `DOES NOT VERIFY` on a debug APK

Normal for a debug build signed with the ephemeral debug keystore after the
keystore was regenerated. It still installs on a device or emulator with
`adb install`. A release build needs a real keystore.

### `aapt2: command not found`

Build tools are not installed, or `aapt2` is not on `PATH`. The inspector
resolves it from `$ANDROID_HOME/build-tools/*/aapt2`; check that directory
exists.

## Sandbox and Docker

### `permission denied while trying to connect to the Docker daemon socket`

The backend user is not in the `docker` group, or the socket is not mounted into
the backend container. Either add the mount:

```yaml
- /var/run/docker.sock:/var/run/docker.sock
```

or set `SANDBOX_ENABLED=false` and accept the host backend (reported in
`/api/system/status` so it is never hidden).

### Commands fail with `permission denied` writing into the workspace

The sandbox runs as uid 1000. The workspace must be owned by 1000:

```bash
sudo chown -R 1000:1000 /data/workspaces /data/storage
```

### The sandbox starts further containers when it should not

It should not be able to: the Docker socket is deliberately not mounted into the
sandbox. If it can, you are on the host backend - check `sandbox` in
`/api/system/status`.

## Frontend

### Blank page after deploying to Cloudflare Pages

Almost always a wrong root directory. Set it to `frontend`; the build output is
`dist` relative to that.

### Deep links 404 on refresh

`_redirects` is missing from the deployed bundle. It lives in
`frontend/public/`, which Vite copies to `dist/`. Confirm it is there after a
build.

### The UI shows stale data after an agent run

The WebSocket dropped and the client fell back to polling. Check the browser
console for a failed `wss://` connection - a proxy that does not forward
`Upgrade` and `Connection` headers is the usual cause. See the nginx block in
`DEPLOYMENT.md`.

## CI

### CI fails with `npm ci` and `package-lock.json not found`

This is an npm workspace; there is no per-package lockfile. Install at the
repository root, not inside `backend/` or `frontend/`.

### CI Android job fails at the APK verification step

That is the step working as intended: no APK on disk means the build failed even
if Gradle exited 0. Read the `Run unit tests` and `Assemble debug APK` output
above it for the real error.

### A fork PR cannot read secrets

Correct, and intentional. `pull_request` does not expose secrets to forks. Do not
switch to `pull_request_target` with a checkout of the fork's code - that runs
untrusted code with write permissions.
