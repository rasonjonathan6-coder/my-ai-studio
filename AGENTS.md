# Repository notes for agents

My AI Studio — an AI coding workspace that runs a real agent loop against real
project workspaces and produces real Android APKs. The guiding rule everywhere is
that a status must reflect something that actually ran. `NOT AVAILABLE`,
`NOT TESTED` and `NOT CONFIGURED` are correct answers; a fabricated `PASS` is not.

## Layout

- `backend/` — Node + TypeScript REST/WebSocket API. `src/routes/` for HTTP,
  `src/services/` for the domain (workspace, command runner, build, APK
  inspection, security scan, export, OpenRouter), `src/agent/loop.ts` for the
  agent loop, `src/db/migrate.ts` for migrations.
- `frontend/` — React + TypeScript + Vite, mobile-first. Deployed to Cloudflare
  Pages; `VITE_API_URL` is the only build-time variable and must never hold a
  secret.
- `sandbox/` — the image commands run in when `SANDBOX_ENABLED=true`.
- `scripts/dev-stack.sh` — how this workspace actually starts the stack
  (`up`/`down`/`status`). Prefer it over `docker compose` here, because compose
  needs `POSTGRES_PASSWORD` and a `.env` that is not committed.
- `android-samples/` — the Android templates the product builds.
- `docs/AGENT_LOOP_TESTING.md` — how to verify the loop, including when the
  model is unavailable.

## Commands

```bash
npm run typecheck && npm run lint && npm run test && npm run build   # whole monorepo
npm test -w backend                                                  # backend only
bash scripts/dev-stack.sh up                                         # start mas-pg + mas-api
bash scripts/smoke.sh                                                # HTTP smoke suite
```

This is an npm workspace: install at the repository root, never inside
`backend/` or `frontend/`. There is no per-package lockfile, so CI must use a
root-level install.

## Things that will waste your time if you forget them

- Docker needs `sudo -n docker` in this environment, and the backend container is
  started with the docker socket mounted so builds can spawn a sandbox.
- PostgreSQL only listens inside the docker network. To query it from the host,
  `sudo -n docker exec mas-pg psql -U studio -d myaistudio -c '...'`. There is no
  host `psql`.
- The sandbox mounts paths as the **Docker daemon** sees them, not as the backend
  container sees them. A path that is valid in one but not the other is the most
  common build failure.
- `messages` has no `agent_run_id` column; messages hang off `conversations`.
  A query that assumes otherwise will fail even though the application is fine.
- Gradle is invoked through the project's wrapper, not a system `gradle`, so
  `GET /api/system/status` reporting gradle as `NOT AVAILABLE` is expected.
- The command deny list is two-tiered and this is deliberate. Patterns whose
  target is the execution environment (`rm -rf /`, `rm -rf /workspace`, fork
  bombs, disk wipes, reverse shells) apply on **both** backends, because the
  sandbox mounts the project read-write at `/workspace` and would otherwise let
  a command delete the project it is building. Host-only patterns (docker socket,
  `sudo`, `shutdown`) must not be blocked inside the container or legitimate
  builds break. `hostDenyReason` and `sandboxDenyReason` are separate exports for
  this reason; use `denyReasonFor(command, backend)` when you need the right one.
- A command that deletes files *inside* the project is allowed by design. The
  deny list cannot protect a project from its own model, only from wiping the
  mount root. Do not add tests that assume otherwise.
- Running a destructive command through the terminal endpoint during testing
  damages a real workspace. Use a scratch project you do not need, and check
  `git status` in the project afterwards.

## Model integration

Three providers are supported: OpenRouter (`OPENROUTER_*`), Google Gemini
(`GEMINI_*`, reached through its OpenAI-compatible endpoint) and Groq
(`GROQ_*`). Every key is read server-side only and must never reach the frontend
bundle, an APK, a log, an exported ZIP or a response body. `*_BASE_URL` exists so
a local stand-in can be used for testing without spending quota.

`AI_DEFAULT_PROVIDER` (`auto` by default) and `AI_PROVIDER_ORDER`
(`openrouter,gemini,groq`) decide which provider serves a run:

- `auto` walks the order and fails over **only** on temporary conditions
  (`rate_limited`, `quota_exhausted`, `timeout`, `network_error`, 5xx). A 400,
  401 or 403 surfaces immediately: a bad key must stay visible instead of being
  masked by a failover that would make every provider look broken.
- A named provider pins the run to it; failure is reported, never silently
  switched away from.
- A provider that hit a hard quota or a throttle enters a cooldown
  (`AI_PROVIDER_COOLDOWN_MS`, default 5 min) and is skipped by later AUTO runs.
  `POST /api/ai/providers/:id/reset` clears it.
- `POST /api/ai/providers/:id/test` performs a real completion and reports the
  observed HTTP status; a provider is never labelled connected without a round
  trip. `connection` stays `NOT_TESTED` until then.

`ChatFailure.kind` has no `quota_exhausted` member: an exhausted quota stays
`rate_limited` with `quotaExhausted: true` and `retryable: false`, so callers
that switch on `kind` keep working and the reset instant travels as
`retryAfterMs`. The agent loop only waits out a throttle that is actually
retryable.

Free-tier behaviour worth remembering:

- `openrouter/free` is capped **per day** (50 requests), not per minute. An
  exhausted quota returns 429 with `free-models-per-day` in the body and
  `X-RateLimit-Reset` (epoch milliseconds) in the headers. The client does not
  retry this inside a run; it reports the reset time.
- A plain 429 without that marker is a transient throttle and is retried with
  backoff, honouring `Retry-After` when present.
- The API key must never be echoed, even partially, when reporting an error.

## Verifying the agent loop without a model

`scripts/scripted-model.mjs` replaces only the model transport and replays a
fixed tool sequence. Every tool still executes for real, and the loop's VERIFY
phase always runs the real build regardless of what the model claims. Full
procedure in `docs/AGENT_LOOP_TESTING.md`.

The most valuable assertion in this repository is the negative one: a build that
fails must report `status: failed` with `apk: null`. A regression once let a
failed build re-attach the previous build's APK.

## Terminal statuses are write-once

An agent run that exceeds `AGENT_TIMEOUT` is rejected by the job queue while
the abandoned run keeps executing its in-flight `await`. It must not be able
to rewrite its own row afterwards, or a run the user saw time out can turn
green later. The success path therefore checks the abort signal and uses
`finishRun`, which only applies when the row is still `queued` or `running`.
Any new terminal write should go through `finishRun` for the same reason.

