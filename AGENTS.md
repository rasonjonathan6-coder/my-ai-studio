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

Twelve providers share one router. Three are first-class: OpenRouter
(`OPENROUTER_*`), Google Gemini (`GEMINI_*`, via its OpenAI-compatible endpoint)
and Groq (`GROQ_*`). Nine more are wired the same way and stay out of rotation
until their key is set: Cerebras, Mistral, Cloudflare (needs both
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), NVIDIA, Hugging Face
(`HF_TOKEN`), Chutes, SambaNova, plus the local `ollama` and `vllm` runtimes,
which use a URL and no key. Every key is read server-side only and must never
reach the frontend bundle, an APK, a log, an exported ZIP or a response body.
`*_BASE_URL` exists so a local stand-in can be used for testing without spending
quota; the test suite relies on this.

`AI_DEFAULT_PROVIDER` (`auto` by default) and `AI_PROVIDER_PRIORITY`
(`openrouter,gemini,groq,...`) decide which provider serves a run.
`AI_PROVIDER_ORDER` is the older name for the same setting and is still honoured
as a fallback:

- `auto` walks the priority and fails over **only** on temporary conditions
  (`rate_limited`, `quota_exhausted`, `timeout`, `network_error`, 5xx). A 400,
  401 or 403 surfaces immediately: a bad key must stay visible instead of being
  masked by a failover that would make every provider look broken.
- A named provider pins the run to it; failure is reported, never silently
  switched away from. A pinned failure still records its cooldown, so a later
  AUTO run does not walk straight back into a provider just proven unavailable.
- A provider that hit a hard quota or a throttle enters a cooldown that
  escalates on repeat (`AI_PROVIDER_COOLDOWN_MS` -> 1m -> 5m, capped at
  `AI_PROVIDER_COOLDOWN_MAX_MS`, default 15m). The provider's own `Retry-After`
  always wins, and a success resets the ladder to zero.
  `POST /api/ai/providers/:id/reset` clears it and resets the ladder.
- `POST /api/ai/providers/:id/test` performs a real completion and reports the
  observed HTTP status and the error classification; a provider is never labelled
  connected without a round trip. `connection` stays `NOT_TESTED` until then.
- `POST /api/ai/providers/:id/probe` checks reachability by listing models. It
  answers whether the provider is up without spending completion quota.
- `POST /api/ai/providers/auto/auto-probe` runs one real request through the AUTO
  path and returns the full attempt trail, so the failover chain can be observed
  rather than assumed.
- `GET /api/ai/providers` returns a `providerStates` array whose every field is an
  observed fact. A value that was never observed is `null`, never a plausible
  default: an untouched provider reports `lastStatusCode: null`, not `200`.

`ChatFailure.kind` has no `quota_exhausted` member: an exhausted quota stays
`rate_limited` with `quotaExhausted: true` and `retryable: false`, so callers
that switch on `kind` keep working and the reset instant travels as
`retryAfterMs`. `classification` carries the finer label (`QUOTA_RATE_LIMIT`,
`TEMPORARY_FAILURE`, `AUTHENTICATION`, `BAD_REQUEST`). The agent loop only waits
out a throttle that is actually retryable.

Free-tier behaviour worth remembering:

- Groq's `gpt-oss-*` models cannot serve the agent. They ship a built-in
  `repo_browser` tool that fires on tool-shaped prompts and is rejected by the
  API with HTTP 400 `tool_use_failed` ("Tool choice is none, but model called a
  tool"), regardless of `tool_choice`, an empty `tools` array,
  `reasoning_effort`, or `parallel_tool_calls`. Groq's default model is
  therefore `qwen/qwen3.8-27b`, which follows the text JSON protocol. Verified
  by direct API calls, not inferred.
- Groq's free tier caps tokens **per minute** (8000 on `qwen/qwen3.8-27b`) as
  well as requests. A multi-turn agent run easily spends that budget, so a run
  can fail partway with `rate_limited` after several successful turns. The
  workspace changes made before the limit are real and are kept.
- `openrouter/free` is capped **per day** (50 requests), not per minute. An
  exhausted quota returns 429 with `free-models-per-day` in the body and
  `X-RateLimit-Reset` (epoch milliseconds) in the headers. The client does not
  retry this inside a run; it reports the reset time. The free alias also routes
  to an unspecified backend, so a named free model
  (`qwen/qwen3.8-27b:free`) is the default.
- A plain 429 without that marker is a transient throttle and is retried with
  backoff, honouring `Retry-After` when present.
- The API key must never be echoed, even partially, when reporting an error.
- No provider API exposes a remaining-quota figure. The UI shows request counts
  the router itself observed (`requestCounters`) and reports the remaining quota
  as `unknown`; inventing a number would be worse than reporting none.

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

