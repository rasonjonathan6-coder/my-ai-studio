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

## GitHub Actions integration

`backend/src/services/githubActions.ts` reports the state of the latest workflow
run on the configured repository. `GITHUB_REPO` is the only hard requirement: a
public repository is probed without a token, which is what makes `AVAILABLE` a
real observation instead of a claim about configuration. `GITHUB_TOKEN` widens
rate limits, unlocks private repositories, and is required for artifact
downloads - GitHub refuses action artifact downloads without authentication, so a
token-less server answers `503` rather than fetching anonymously.

The artifact route (`GET /api/system/github/artifacts/:id`) verifies the id
belongs to the latest run of the *configured* repository before streaming;
otherwise an id from any other repository would be a proxy for the server's
token.

### Dispatching a workflow_dispatch workflow

GitHub only registers a `workflow_dispatch` workflow that exists on the
repository's **default** branch. A publish that writes the managed workflow only
to the build branch (`my-ai-studio-build`) leaves `GET /actions/workflows` at
`total_count: 0`, and every dispatch of it answers `404 Not Found` even though
the file is plainly in the build branch. `syncWorkspaceToRepo` therefore also
installs the managed workflow on the default branch. The write is skipped when a
blob with the same content already exists, so repeated publishes do not pile
commits onto a project's main branch. `SyncResult` reports
`workflowOnDefaultBranch`, and a default-branch failure leaves publishing itself
successful (`defaultBranchError` explains why dispatch would not work).

Also note that GitHub's `/actions/runs/:id/logs` endpoint returns a **zip** of
one `.txt` per job, not text. Returning the byte count as if it were a log
description is not the log; `extractRunLogText` unpacks the archive in-process
using the same reader as the APK path and returns the real redacted text,
refusing non-archives.

Do not render a bare environment-variable name in frontend code. The secret
guard in `.github/workflows/build.yml` fails the build when the literal strings
`sk-or-`, `OPENROUTER_API_KEY`, `DATABASE_URL` or `JWT_SECRET` appear anywhere in
`dist/`, including inside a user-facing hint. `Settings.tsx` once contained
"set JWT_SECRET in production" and broke the build only at the bundle step.

## Local dev stack

`scripts/dev-stack.sh up` starts Postgres and the backend with the toolchain
mounts (`/opt/android-sdk`, `/opt/gradle-cache`) that Gradle tests and APK builds
need. Starting the backend container by hand without those mounts makes steps 9
and 10 of `scripts/smoke.sh` fail with "SDK location not found" - an environment
problem, not a product bug. If `mas-pg` was created with a different password
than `.dev-credentials` holds, TCP auth fails while the postgres superuser still
works over the local socket; reset with
`docker exec mas-pg psql -U studio -d myaistudio -c "ALTER ROLE studio WITH PASSWORD '...'"`.

## Provider keys and the dev stack

Provider credentials go in the gitignored `.env` only. `scripts/dev-stack.sh`
forwards them into the backend container from an explicit list, so adding a key
is not enough on its own - a provider missing from that list looks identical to
an unconfigured one. Cloudflare is the exception to the key/model pair shape: it
needs `CLOUDFLARE_ACCOUNT_ID` too, because the account id is part of the
OpenAI-compatible path (without it `baseUrl` is empty and the client fails with
"Failed to parse URL from /chat/completions").

Never trust a default model id to still exist. `GET /v1/models` on the provider
is the authority, and a key can be perfectly valid while both the model and the
account entitlement are wrong - the failure code tells them apart:

| Response | Meaning |
| --- | --- |
| 401 | key or token rejected |
| 402 / 429 | key valid, no credit or quota |
| 404 `not available on X` | model id wrong, or not entitled on this account |
| 410 | model listed but retired |

Observed on this workspace: Cerebras and Mistral are billing/quota failures only
(402 and 429) - the keys are valid, so there is nothing to fix in code. Gemini's
quota is per-model, so a 429 on one model does not mean the key is unusable:
probe siblings before declaring the provider dead (`gemini-3.6-flash` was
exhausted while `gemini-3.5-flash-lite` answered 200). Cloudflare's token needed
the Workers AI permission, and the model list is the authority for model ids
(65 models here); the previously configured `@cf/meta/llama-3.1-8b-instruct` is
deprecated and now answers 410. NVIDIA's key was valid but the account is only
entitled to current models: `nvidia/nemotron-3-super-120b-a12b` answers 200 while
older llama ids 404. Note the 404-vs-410 split - 410 means the model exists but
is retired, 404 means it is not available to this account.

Cross-checking the router against a direct provider call still matters: a 429
from the router on OpenRouter's free tier can be transient, and a retry a few
seconds later returns 200. The AUTO failover path is exercised with
`POST /api/ai/providers/auto/auto-probe`, which reports which provider actually
answered and the full attempt trail.

Tests must not depend on the machine's `.env`. `aiProvider.test.ts` blanks every
provider credential before asserting `not_configured`, otherwise a developer with
providers configured turns a unit test into a real network call.

## FREE_ONLY agent runs

A free model can stall without failing. The router tries several models per
provider, so one unresponsive variant used to consume the whole run budget and
the run sat in `analyzing` with `tokens_in = 0` while the provider retry log
filled up. `AI_FREE_MODEL_TIMEOUT_MS` (default 45s) now caps each attempt so a
stall rolls over to the next candidate.

Reasoning models on the free pool bill their reasoning trace against the output
budget. With no `max_tokens` set, `cohere/north-mini-code:free` returned HTTP 200
with `content: null` (all 20 tokens went to reasoning), which the adapter read as
`invalid_response`. The agent loop now sends `AI_MAX_OUTPUT_TOKENS` (default
2048) so the answer has room.

The agent's `run_command` tool used to call `runCommand` directly, bypassing
`terminal.ts`. Agent commands therefore never reached the `commands` table and
were invisible in the terminal view even though they really ran. It now goes
through `runTerminalCommand` with `source: 'agent'`; the read-only `git_status`
and `git_diff` tools still use `runCommand` since they are not auditable work.

`002_agent_runs_provider.sql` pinned `agent_runs.provider` to three providers. A
run served by a newer provider - or refused by FREE_ONLY before any request -
failed that CHECK and the terminal status could not be written, so the run looked
stuck. Migration `003_agent_runs_provider_all.sql` widens both provider columns
to the full router set. When adding a provider, this constraint list is one of
the places that must be updated.

A repository that a credential can *read* is not a repository it can *write*. The
GitHub status probe used to report `AVAILABLE` for a read-only installation token,
which made the Build Center look healthy right up until a publish was refused with
`403 Resource not accessible by integration`. `GET /api/system/github` now carries
`canWrite`, determined by actually creating a blob that nothing references: a real
write attempt is the only way to tell the two apart, and a dangling blob cannot
touch a branch, a commit or the working tree (GitHub garbage-collects it). A
`403`/`404` on that probe means read-only; any other failure leaves `canWrite`
`null` rather than guessing.

Export used to shell out to the system `zip`/`unzip` binaries, so the whole
feature was unavailable on any image without them and failed with an opaque
`500 zip failed: spawn zip ENOENT`. `src/lib/zipWriter.ts` now builds the archive
in-process (local headers, central directory, EOCD) and `src/services/export.ts`
walks the workspace itself, so the exclusions are applied to the exact bytes that
are archived. The finished archive is read back with the production ZIP reader
before being offered as a download, which turns a writer bug into a clean error
instead of a corrupt file. Exclusion rules match whole path segments and exact
stems (`mynode_modules/` and `secretsanta.txt` survive; `node_modules/` and
`secrets.json` do not), and symlinks are skipped rather than followed out of the
workspace.

Build steps that locate an APK must refuse a stale one. `assembleDebug` can
report `BUILD SUCCESSFUL` with every task `UP-TO-DATE` while the APK on disk is
from an earlier build; the build service compares the artifact's mtime against
the build start and fails with "predates this build" rather than attaching the
old file. When validating this path, delete `app/build` first or the honest
answer is a refusal, not a fresh artifact.

The APK secret scan and APK inspection also used to shell out to `unzip`, so on
an image without it the archive was never examined while the project scan still
reported `clean` - a key could ship inside the APK undetected. Both now use
`readZipEntries`/`readZipEntry` from `src/lib/apkZip.ts`. The scan result
carries `apkScanned`, and a caller that ignores it is reporting on a scan that
did not happen; `apkNote` states how many entries were read and why it failed
when it did.

The Android translator template is generated, not hand-written.
`android-samples/translator` is the source of truth and is the app the
`build-apk` workflow compiles; `npm run sync:translator-template -w backend`
embeds its files into `backend/src/services/translatorTemplateFiles.ts` with
`JSON.stringify`, so escaping is correct by construction. Hand-copying Kotlin
into TypeScript template literals is what let the shipped template rot into a
stub that never sent a translation. The package name and app label are stored as
`__PACKAGE__`/`__APP_LABEL__` and substituted per project, in file paths as well
as content. A backend test re-runs the sync and fails if the checked-in file is
stale, so editing the sample without regenerating is caught.

`build-apk.yml` runs `lintDebug` because it catches what compilation cannot: it
found `AccessibilityNodeInfo.hintText` (API 26+) in an app with `minSdk 24`,
which compiles and then crashes on the device. Lint fails on errors, not
warnings, and all three samples pass it.

The translator calls the studio's own `POST /api/translate` rather than any
provider, so no provider key exists in the APK. The endpoint runs through the
same `AUTO` router as the rest of the studio, so FREE_ONLY and failover apply.
Injection uses `ACTION_SET_TEXT` and then re-reads the field: an app can accept
the action and discard it, so a write is only reported as injected when the
read-back matches. Reading other apps' text and writing into them depends on the
target app exposing its views and accepting the write; when it does not, the app
says which step failed instead of showing the translation as if it had been
inserted. There is no emulator host and no KVM in this environment, so on-device
behaviour is NOT TESTED; the Android emulator preview was removed from the
product for that reason. The build path is verified by CI.


## Operational notes that cost real debugging time

**Never let a startup default generate a key that protects stored data.** The
GitHub credential is encrypted at rest, and the key was derived from
`JWT_SECRET`. When `JWT_SECRET` is unset, config generates a random one *per
process*, so the key changed on every boot and the stored credential could never
be decrypted again — the symptom looked like a broken credential, not a broken
key. There is now a dedicated `MY_AI_STUDIO_CREDENTIAL_KEY` (preferred, with
`JWT_SECRET` as fallback), `credentialKeyIsStable` is reported, and production
logs an error when neither is set. Any future at-rest key must be sourced the
same way: explicit env var, with instability reported rather than silently
absorbed. The same random-secret behaviour invalidates sessions across restarts,
which is why a mid-session 401 is a symptom of the same root cause.

**A credential stored in the database must outrank a host-injected one.** If the
runtime injects `GITHUB_TOKEN` (for example a `ghu_` token from the sandbox) the
env credential is a fallback only. The admin-set, database-held credential wins,
and the resolved `source`, `fingerprint` and `tokenKind` are logged so which one
is in play is never a guess.

**Secret-scan regexes must match values, not names.** Adding `GITHUB_TOKEN`,
`CREDENTIAL_KEY`, `DATABASE_URL` and `JWT_SECRET` to the built-bundle scan made
it fail on legitimate UI copy ("... independent of any GITHUB_TOKEN the host
environment ...") and on the `github_pat_...` input placeholder. The bundle scan
now matches value shapes (`github_pat_[A-Za-z0-9_]{20,}`, `gh[pousr]_...`,
`sk-or-...`, a `postgres://user:pass@` URL, a private-key header). The
working-tree scan still matches `NAME=value` pairs, where a name match is the
point.

**`tsc --noEmit` and the production build are different gates.** `npm run build`
runs `tsc -b`, which resolves project references and was stricter than the
typecheck used during development; it caught a test fixture missing required
fields that `tsc --noEmit` accepted. Run the production build before believing
the types are fine.

**Export is a `POST`.** `POST /api/projects/:id/export` generates the ZIP and
returns its path, entry count, size and sha256; `GET .../download/zip` streams a
fresh archive. A `GET` against the export path 404s, which reads like a missing
feature but is a wrong verb.

**An in-app Android build needs two sandbox mounts, not one.** `gradle` is
absent by design (projects use their own wrapper), so a failing Android build is
never about the `gradle` binary. What bites is the cache. If the configured
`GRADLE_USER_HOME` is not writable inside the sandbox, `toolchainEnv()` logs
`configured GRADLE_USER_HOME is not writable in the sandbox; using an ephemeral
cache` and falls back to `/tmp/gradle-home`. But `commandRunner.ts` mounts `/tmp`
as `--tmpfs /tmp:rw,exec,size=512m`, so Gradle's cache outgrows it and the build
dies with:

```
Exception: Could not add entry '...transforms/.../results.bin'
to cache fileHashes.bin (.../fileHashes/fileHashes.bin)
```

That error mentions neither disk space nor ENOSPC, so it reads like a corrupt
cache. It is an exhausted tmpfs. Fix by supplying both mounts, and make the cache
directory writable by uid 1000 (the sandbox user):

```
SANDBOX_EXTRA_MOUNTS=/host/android-sdk:/opt/android-sdk:ro,/host/gradle:/home/node/.gradle
ANDROID_HOME=/opt/android-sdk
INSTALL_ANDROID_TOOLCHAIN=1
```

With a writable cache the fallback is not logged and builds succeed. Symptom to
watch for: the `not writable` warning appearing immediately before a build
failure is the whole diagnosis.

## Redeploying after changing `.env`

`docker compose ... up -d` reuses an existing container, so a changed `.env`
value does not reach a running service. A plain `restart` is not enough either:
the container keeps its original environment. Use `--force-recreate` on the
service you changed:

```
docker compose -p masprod -f docker-compose.prod.yml up -d --force-recreate backend
```

Verify what the container actually received rather than what the file says: a
32-hex secret is easy to eyeball as unchanged.

```
docker exec masprod-backend-1 sh -c 'printf "%s" "$DATABASE_URL"' | md5sum
printf "%s" "$(sed -n 's/^DATABASE_URL=//p' .env)" | md5sum
```

If those digests differ, the container is stale.

### `sudo -E` leaks the shell's environment into compose

`POSTGRES_PASSWORD` and `DATABASE_URL` are registered credentials here, so they
are auto-exported into every command. `sudo -E` forwards them, and an exported
variable takes precedence over `.env` during compose interpolation — so a
deployment can be recreated with a stale password while `.env` holds the new
one. Strip them explicitly:

```
sudo -E env -u POSTGRES_PASSWORD -u DATABASE_URL docker compose ... up -d --force-recreate backend
```

### Verifying a database password

Do not judge this with `psql -c 'select 1'` inside the postgres container: its
`pg_hba.conf` trusts local connections, so any password string succeeds. The
real signal is the backend probe, which connects over TCP:

```
GET /api/system/status   # postgres probe: AVAILABLE | ERROR "password authentication failed"
```

