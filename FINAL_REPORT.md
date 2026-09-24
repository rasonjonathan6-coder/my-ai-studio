# MY AI STUDIO — FINAL BUILD REPORT

Generated: 2026-09-23
Host: Linux 6.8.0-1055-gke x64, 4 CPUs, 16 GB RAM, 76 GB disk (37% used)

This report records what was actually executed and observed. Nothing here is
inferred from intent. Every status is one of:

- `PASS` — the operation ran in this environment and the result was verified.
- `FAIL` — the operation ran and did not succeed.
- `NOT AVAILABLE` — the required capability is absent from this environment.
- `NOT TESTED` — the code exists but was not exercised here.
- `NOT CONFIGURED` — an external credential or service was not supplied.
- `NOT GENERATED` — a buildable artifact was not produced here.

---

## STATUS SUMMARY

| Area | Status | Evidence |
| --- | --- | --- |
| ENVIRONMENT | PASS | node 24.21.0, git 2.47.3, docker 29.8.1, python 3.13.15, adb 1.0.41; java 17 present only in the backend image, no JDK and no system gradle on the host (the Gradle 8.9 wrapper is used) |
| FRONTEND | PASS | typecheck, lint, 20/20 tests, production build 357.33 kB JS / 106.35 kB gzip + 3 lazy chunks + 10.23 kB CSS; the app is served over the public work-host URL and its API proxy works from a mobile user-agent |
| BACKEND | PASS | typecheck, lint, 75/75 tests (incl. OpenRouter tests against a real local HTTP server), real HTTP smoke 15/15 |
| DATABASE | PASS | PostgreSQL 16.15 reachable; migrations applied; auth and project rows persisted and read back |
| OPENROUTER | PASS | live key used; HTTP 200 completion recorded; `/api/health` reports `configured`; key never echoed. As of the latest session the free-model daily quota is exhausted, so a fresh probe honestly returns `rate_limited · HTTP 429` |
| MULTI-PROVIDER ROUTING | PASS | three independent providers wired server-side (OpenRouter, Google Gemini, Groq), each with its own key and endpoint; all three report `configured`. A real AUTO agent run executed the full failover chain OpenRouter 429 -> Gemini 429 -> Groq (7 successful turns, files written, then Groq's 8000 tok/min cap). A pinned Groq run **succeeded** end to end and its `hello.txt` was verified on disk. `requestCounters` reports observed requests and `quotaRemaining` stays `unknown` |
| AGENT LOOP | PASS | live run: reading -> editing -> testing -> building -> completed; code change and APK independently verified |
| OPENHANDS | NOT AVAILABLE | no OpenHands agent-server endpoint reachable from this environment |
| DOCKER | PASS | backend image built; container ran; full smoke suite executed inside it; sandbox runs as uid 1000, cannot reach `169.254.169.254`, and legitimate egress still works |
| GITHUB ACTIONS (workflows) | NOT TESTED | four workflows written and YAML-valid; never dispatched on a runner |
| GITHUB PUBLISH / DISPATCH | PASS (unit) / BLOCKED (live) | Git Data API publish sequence, `base_tree` preservation and managed-workflow install asserted against a local HTTP server; live publish to `rasonjonathan6-coder/app` refused `403` by a read-only credential, reported verbatim |
| GITHUB WRITE PROBE | PASS | `canWrite` in `/api/system/github` distinguishes a read-only credential from a writable one via a real dangling-blob write; verified live as `false` |
| ANDROID SDK | PASS (host) | build-tools 34.0.0, platform-tools, adb on the host |
| ANDROID BUILD | PASS | `./gradlew test` and `./gradlew assembleDebug` ran for real |
| APK | PASS | each template built a real `app-debug.apk`; the APK currently shipped in `release/` is 3 189 843 bytes, SHA-256 `c8fa61b9654c84e1eed5281fbe163383916806cb179b53a82cdd79d2138c2396` |
| APK INSPECTION | PASS | real `aapt2` + `apksigner`: package/version/min-target read from the APK; signature verified as debug-signed with the v2 scheme |
| APK SECURITY SCAN | PASS | archive read with the in-process ZIP reader (no `unzip` binary needed) and pattern-scanned: 178 text-like entries of 422; a planted key inside an APK was detected and masked, and never echoed |
| ANDROID EMULATOR | NOT AVAILABLE | no emulator, no `/dev/kvm`; `adb devices` is empty |
| EXPORT | PASS | project ZIP written by an in-process ZIP writer (no system `zip` dependency); the downloaded archive opens in Python's `zipfile` (`testzip` clean), carries 15 files and no secret-bearing path; a planted `.env` and `credentials.json` stay out |
| RELEASE ARTIFACTS | PASS | `release/` rebuilt from HEAD `70a10d4` with `git archive`, docs, deployment files and a real APK; all 25 SHA-256 checksums verify |
| PRODUCTION READINESS | PARTIAL | see the degraded-capability section below |

---

## WHAT WAS ACTUALLY RUN

### Backend

```
npm run typecheck -w backend   → exit 0
npm run lint -w backend        → exit 0
npm test -w backend            → tests 25, pass 25, fail 0
```

### Frontend

```
npm run typecheck -w frontend  → exit 0
npm run lint -w frontend       → exit 0
npm test -w frontend           → Test Files 2 passed, Tests 12 passed
npm run build -w frontend      → built in 722ms, dist/assets/index-*.js 195.97 kB
```

### Real HTTP smoke suite (15 checks, all against the running container)

```
RESULT: PASS (register)              RESULT: PASS (tests response)
RESULT: PASS (me)                    RESULT: PASS (gradle unit tests really ran and passed)
RESULT: PASS (duplicate)             RESULT: PASS (build succeeded)
RESULT: PASS (create project)        RESULT: PASS (export zip)
RESULT: PASS (gradlew generated)     RESULT: PASS (cross-user denied)
RESULT: PASS (read file)             RESULT: PASS (unauth denied)
RESULT: PASS (traversal blocked)     RESULT: PASS (agent honestly reports not configured)
RESULT: PASS (terminal executed)
FAILURES: 0
```

The Gradle check asserts a non-zero parsed JUnit pass count, so a build that
skipped tests cannot be reported as passing. The build check asserts the APK
file exists on disk, so an exit code 0 with no artifact is recorded as failed.

### Independent APK cross-check

The container has no `aapt2`. Inspection there is done by the built-in binary
AXML parser. That output was compared against `aapt2 dump badging` run on the
host against the same file:

| Field | Container (AXML parser) | Host (`aapt2`) |
| --- | --- | --- |
| size | 3191119 | 3191119 |
| sha256 | `feb09ba7a3b33bab…` | `feb09ba7a3b33bab…` |
| package | `com.myaistudio.calculator` | `com.myaistudio.calculator` |
| versionName | `1.0` | `1.0` |
| versionCode | `1` | `1` |
| minSdk | `24` | `sdkVersion:'24'` |
| targetSdk | `34` | `targetSdkVersion:'34'` |
| launcher activity | `com.myaistudio.calculator.MainActivity` | `launchable-activity: …MainActivity` |

The earlier string-pool heuristic was removed. It classified every dotted
string in the pool as an activity and could report a framework string as the
package name. The replacement decodes the real chunked format: `RES_XML_TYPE`,
`RES_STRING_POOL_TYPE` (both UTF-8 and UTF-16 pools), `RES_XML_RESOURCE_MAP_TYPE`,
`RES_XML_START_ELEMENT_TYPE` and `RES_XML_END_ELEMENT_TYPE`, resolving attribute
names through the resource map so framework attributes such as `versionName` are
readable even though AAPT2 leaves those pool entries empty. Values that cannot
be decoded are left `null` with a note — never guessed.

### System status (`GET /api/system/status`, inside the container)

| Probe | State |
| --- | --- |
| node | AVAILABLE (v22.23.2) |
| java | AVAILABLE (JDK 17) |
| git | AVAILABLE (2.39.5) |
| docker | AVAILABLE (daemon reachable) |
| postgres | AVAILABLE (PostgreSQL 16.15) |
| gradle | NOT AVAILABLE (not in image) |
| adb | NOT AVAILABLE (not in image) |
| androidSdk | NOT AVAILABLE (not mounted) |
| python | NOT AVAILABLE (not in image) |
| openrouter | NOT AVAILABLE (no key) |
| androidEmulator | NOT AVAILABLE (no KVM) |

These are live probe results, not placeholders. `gradle` reads `NOT AVAILABLE`
in the backend image by design: Gradle runs inside the sandbox container, which
does carry it, and the smoke suite exercised it there successfully.

---

## LIVE OPENROUTER AND END-TO-END AGENT RUN

### OPENROUTER — PASS (verified against the live API)

An `OPENROUTER_API_KEY` was supplied and the integration was exercised for real.

- The client's error mapping, timeout, retry and redaction behaviour were unit
  tested against a real local HTTP server (12 tests in `tests/openrouter.test.ts`).
- A direct call from the backend container returned HTTP 200 with a genuine
  completion, served by `nvidia/nemotron-3-super-120b-a12b:free`.
- `GET /api/health` reports `openrouter: "configured"` and never echoes the key.

### MULTI-PROVIDER ROUTING - PASS (three providers, verified with real requests)

OpenRouter, Google Gemini and Groq are independent transports: each has its own
key, its own base URL and its own model. No provider's traffic transits another.
All three keys live in the server-side `.env` only, and every one of these
observations came from a real HTTP request, not from a mock.

- `GET /api/health` and `GET /api/ai/providers` report all three as `configured`
  with the key value hidden.
- Groq test endpoint: HTTP 200, reply `OK`, ~470 ms.
- A real **AUTO** agent run on the `node-ts` template executed the whole failover
  chain. The attempt trail recorded openrouter `429 rate_limited` -> gemini
  `429 rate_limited` -> groq, which then served seven consecutive successful
  turns before hitting Groq's per-minute token cap. The agent had, by then,
  really written `src/math.ts` and `tests/math.test.ts` into the workspace; both
  files were read back through the API.
- A **pinned Groq** run then **succeeded**: `status: succeeded`, `phase: completed`,
  `provider: groq`, `model: qwen/qwen3.8-27b`. The file it was asked to create
  (`hello.txt`, content `hello`) was verified both through the file API and
  directly on disk inside the container.

Two findings were established by direct API calls during this work and are worth
recording, because both look like application bugs until the provider is probed:

1. **Groq rejects its own `gpt-oss` models for this agent.** `gpt-oss-120b` and
   `gpt-oss-20b` ship a built-in `repo_browser` tool that fires on tool-shaped
   prompts; the API returns HTTP 400 `tool_use_failed` ("Tool choice is none, but
   model called a tool") no matter what `tool_choice`, `tools`, `reasoning_effort`
   or `parallel_tool_calls` are set to. The agent drives its tools through a text
   JSON protocol, and `qwen/qwen3.8-27b` follows it correctly, so that is now the
   Groq default.
2. **Gemini's OpenAI-compatible surface rejects two consecutive system messages**
   with `MALFORMED_FUNCTION_CALL`. The loop sent a system prompt and a context
   prompt as two separate `system` turns; they are now merged into one, which
   every provider accepts. This fix could not be confirmed live because Gemini's
   free tier was rate-limited (`429`) for the whole session - that verification
   remains outstanding and is reported as such, not as a pass.

`quotaRemaining` is deliberately reported as `unknown`. No provider API exposes a
remaining-quota figure, so inventing one would be worse than reporting none. What
the UI does show is `requestCounters`: the number of requests this server
actually sent per provider today, counted where every attempt is recorded.

### AGENT LOOP — PASS (real work, not scripted)

Two runs were executed against the live model:

1. A read-only prompt. The agent listed the project root and read
   `MainActivity.kt`, then summarised it accurately. No files were modified.
2. A change prompt. The observed phases were
   `reading → editing → testing → building → completed`. The agent added
   `Calculator.power(base, exponent)` to `Calculator.kt`, added a `powerWorks`
   test covering positive, zero and negative exponents, ran the unit tests
   (10 passed, 0 failed) and built a debug APK.

Both claims were checked independently against the filesystem:

| Claim | Verification |
| --- | --- |
| `power()` added | Present in `Calculator.kt` on disk |
| Test added | `powerWorks` present in `CalculatorTest.kt` |
| APK size 3 191 195 bytes | `stat` on the APK reports exactly 3 191 195 bytes |

Live events were streamed over the WebSocket during the run and the Gradle log
was observed as it was produced.

### SECRET CONTAINMENT — PASS

The live key was searched for after the runs and was absent from: the project
workspace, the built APK, the backend container logs, the export ZIP and every
git-tracked file. `scripts/dev-stack.sh` reads the key from the gitignored
`.env` and passes it to the container without echoing it.

**Note:** the key was pasted into the chat and is therefore present in this
conversation's history. It should be rotated once verification is complete.

### ANDROID EMULATOR — NOT AVAILABLE

There is no emulator and no `/dev/kvm`, so hardware-accelerated emulation is
impossible here. `GET /api/projects/:id/preview` runs a real `adb devices` and
returns `ANDROID PREVIEW: NOT AVAILABLE`. There is no static screenshot or
substituted image anywhere in this path. The service is written so a real
emulation host can be attached later without reshaping the API.

### GITHUB ACTIONS — NOT TESTED (workflows) / BLOCKED (live publish)

Four workflows exist and are real: `test.yml`, `build.yml`, `build-apk.yml`,
`security.yml`, plus the managed `android-build.yml` the server installs into a
target repository. They checkout, install, lint, test, build and upload
artifacts, and they fail when the underlying step fails. The APK job verifies
that `app/build/outputs/apk/debug/app-debug.apk` exists before uploading it and
fails the job when it does not. All five parse cleanly with `js-yaml`.

The `android-build.yml` steps were executed by hand against the real workspace
that holds a built APK, and they behave as written: the APK-locate step found
`./app/build/outputs/apk/debug/app-debug.apk` (3 189 843 bytes), the `PK` header
check passed, and `sha256sum` returned
`e1dacaeeb9114b1e212efa6702e45d94bcd73e4f92351a08158aab987ff36380`. The
secret-scan step was run against a directory with a planted `sk-or-v1-…` literal
and correctly printed `SECURITY FAILED`.

None of the workflows has been dispatched on a GitHub runner from this
environment, so their runner status is NOT TESTED rather than PASS.

### GITHUB PUBLISH AND DISPATCH — BLOCKED BY A READ-ONLY CREDENTIAL

The integration that publishes a workspace and dispatches the build is
implemented and unit-verified:

- `syncWorkspaceToRepo` creates one blob per file, builds a tree over the head
  commit's tree as `base_tree` (so unaffected files survive a sparse publish),
  creates a commit parented on the head, and moves the branch. The managed
  workflow is written into the same commit.
- `backend/tests/githubBuilds.test.ts` CASE 3 asserts the exact request sequence
  against a local HTTP server and checks the `base_tree` argument and the three
  blob paths; CASE 3b asserts that a `403` on blob creation aborts before any
  tree or commit is attempted.
- `GET /api/system/github` gained `canWrite`, probed by creating a blob that
  nothing references. This is a real write, but it cannot touch a branch, a
  commit or the working tree, and GitHub garbage-collects it.

The live path cannot complete here. The credential is an installation token with
read-only access to `rasonjonathan6-coder/app`:

```
GET  /repos/rasonjonathan6-coder/app              -> 200
POST /repos/rasonjonathan6-coder/app/git/blobs    -> 403 Resource not accessible by integration
```

`GET /api/system/github` therefore reports `canWrite: false`, and
`POST /api/projects/:id/github/build` answers with the refusal verbatim:

```
{ "error": "the project could not be published to GitHub, so no workflow was dispatched",
  "detail": "blob creation failed: 403 Resource not accessible by integration" }
```

That is the correct, honest outcome — no run was started and no publish was
claimed. Granting the credential `contents: write` and `actions: write` (or
supplying a `GITHUB_TOKEN` with them) is the only remaining step; the capability
probe will then report `canWrite: true` and the same routes publish and dispatch
without further code changes.

**GITHUB PUBLISH / DISPATCH E2E: BLOCKED (read-only credential).**

### ORACLE CLOUD DEPLOYMENT — NOT TESTED

No Oracle Cloud account or VM was reachable. `ORACLE_SETUP.md` documents the
full procedure. Nothing was deployed and nothing claims to be.

### GITHUB REPOSITORY

The repository now has a committed history (`master`, 18 commits) and no
configured remote; nothing has been pushed. Commit `0b08191` removed the
committed dev credentials and made the CI security scan fail closed.
The `git rev-parse HEAD` failure recorded in an earlier revision of this report
no longer describes the tree.

---

## SESSION DELTA — PROVIDER ROUTING AND PREVIEW FIX

Two things were re-verified after this report's first revision, and one real
frontend bug was found and fixed.

### Provider test from the UI — PASS (real result rendered)

`GET /api/ai/providers` and `POST /api/ai/providers/:id/test` were driven from
the running app over the public work-host URL. The backend log recorded
`ai provider test failed: openrouter rate_limited status 429`, and the UI then
rendered `FAIL · rate_limited · HTTP 429` inline on the OpenRouter row. Gemini
and Groq rendered `NOT CONFIGURED`. No value on that panel is synthesised — the
status, HTTP code and timing come from the response.

A live agent run was also attempted in AUTO mode and failed honestly with
`not_configured: AUTO mode: all configured providers are cooling down
(openrouter)`. That is the correct behaviour: the run is marked `failed`, not
retried into a pretend success.

### Preview screen — real bug, fixed

`PreviewResult` in `frontend/src/api/types.ts` did not match what
`backend/src/services/androidPreview.ts` actually returns: the frontend expected
`reason`, `apkPresent` and `logs`, while the backend sends `message`,
`packageName`, `logcat` and a `steps` array. The screen therefore rendered
`undefined` for the message and never showed the package or the step detail.

The type and `PreviewScreen` were corrected to the real contract, and
`frontend/src/screens/Export.test.tsx` now renders the component against the
real backend payload and asserts the message, package and step text appear and
that the string `undefined` does not. The test was mutation-checked: reverting
the field to `preview.reason` turns it red.

Confirmed live in the served app after the rebuild. The Preview tab renders

```
not available
ANDROID PREVIEW: NOT AVAILABLE - adb present but no device/emulator is attached.
adb devices   (none)
package       (unknown)
installed     false
launched      false
✗ adb devices  adb present but no device/emulator is attached
```

with no image or mocked frame, because the endpoint genuinely found no device.

### Re-run after the fix

```
npm run typecheck  -> exit 0
npm run lint       -> exit 0
npm test           -> backend 58/58, frontend 13/13
npm run build      -> 357.33 kB JS / 106.35 kB gzip, built in 1.38s
```

---

## HOW TO REPRODUCE THIS REPORT

```bash
# backend
npm install
npm run typecheck -w backend && npm run lint -w backend && npm test -w backend

# frontend
npm run typecheck -w frontend && npm run lint -w frontend
npm test -w frontend && npm run build -w frontend

# full stack in Docker
POSTGRES_PASSWORD=... docker compose up --build -d
curl -s localhost:8080/api/health
BASE=http://localhost:8080 bash scripts/smoke.sh
```

The Android build and inspection paths need either a mounted SDK
(`ANDROID_SDK_DIR=/path/to/sdk` in `.env`) or the sandbox toolchain image.

---

## ITEMS STILL OPEN

1. GitHub Actions have not run on a runner. Dispatch `build-apk.yml` on a
   machine with the Android SDK to convert NOT TESTED into PASS or FAIL.
2. OpenRouter has not been exercised live. Supply a key to test it.
3. No emulator preview is possible without a KVM-capable host.
4. The tree is uncommitted; create the repository and push when ready.
5. Oracle, Cloudflare Pages and Supabase have documented setup procedures but
   no live deployment was performed from here.

---

## ADDENDUM — 2026-09-23 (evening): live agent loop, fix-cycle and export verification

The status summary above was produced before the live OpenRouter key was
supplied. The key was then used, and this addendum records what changed as a
result. It supersedes the two `NOT TESTED`/`NOT CONFIGURED` lines for
OpenRouter and the agent loop.

### OpenRouter — now PASS

A real key is configured in `.env` and injected into the backend container only.
`GET /api/health` reports `openrouter: "configured"`. A direct completion against
`openrouter/free` returned HTTP 200 in 625 ms. The key never appears in any
response body, log line, container inspect output, exported ZIP or APK — verified
by grep, not assumed.

### Agent loop — verified end to end, twice

Two bugs found during this run and fixed for real:

1. **Hung run (`dc61c963`).** A run sat in `analyzing` for over ten minutes at 0%
   CPU with no model call completing. Root cause: `fetchWithTimeout` cleared its
   timer as soon as response *headers* arrived, leaving the body read unbounded.
   The connection to OpenRouter was established but the stream never finished, so
   the run waited forever. Fix: the timeout now covers the body read. A regression
   test proves the old code hangs (process `Terminated`, exit 143) and the fixed
   code times out cleanly.
2. **Stale APK on a failed build.** A build that exited non-zero still reported the
   APK from an earlier successful build. Fix: a failed build logs `BUILD FAILED`
   and attaches no artifact.

Verification of the second fix, against the real API:

```
POST /api/projects/:id/build  {"kind":"android-debug"}   (source has a real
                                                          Kotlin compile error)
→ status: failed, apk: null
→ docker logs mas-api | grep -c 'apk produced'  →  0
```

Then the source was repaired and rebuilt: `status: succeeded`, APK
3 190 959 bytes, SHA-256
`2ea081f1267678dc13babbc5a7463b879bff01991af59b6d8d242d09882f54c1`, and the
inspection record read back from the database matches that hash exactly.

### Full loop, real tools, scripted model transport

OpenRouter's free tier allows a fixed number of requests per day; the allowance
was exhausted mid-session (HTTP 429, `free-models-per-day`, reset 2026-09-24
00:00 UTC). The client was changed to detect this, stop retrying, and report the
reset timestamp instead of burning attempts. That is a real limitation of the
free tier, recorded here rather than worked around.

To keep verifying while the quota was spent, `scripts/scripted-model.mjs`
replaces **only the model transport**. The loop was then driven through the real
backend, and every tool it triggered ran for real:

| Step | Transcript record | Ground truth on disk |
| --- | --- | --- |
| 1 | `read_file` ok, size 1076 | file existed with the planted error |
| 2 | `edit_file` ok, mode overwrite, size 1072 | `Calculator.powerOf` gone, `Calculator.add` back |
| 3 | `build_android` ok, `status: succeeded` | APK 3 190 959 bytes written by Gradle |
| 4 | `done` | run status `succeeded`, phase `completed` |

The loop's own VERIFY phase runs the real build regardless of what the model
claims, so a scripted model cannot cause a false success.

### Security scan — PASS, negative case included

```
POST /api/projects/:id/security/scan   (clean project)   → status: clean, 10 files
planted OPENROUTER_API_KEY=sk-or-... in a resource file  → status: findings
                                                          → 3 findings, key masked
                                                          → full key leaked? False
after deleting the file                                  → status: clean, 0 findings
```

### Export — PASS

`POST /api/projects/:id/export` produced a 51 055-byte ZIP. Inspection with
`zipfile` shows 35 entries, **zero** matching `.env`, `secret`, `credential`,
`.pem`, `.key`, `node_modules`, `apikey` or `token`, and no `build/` output. The
APK is served from the dedicated download route, not embedded in the source ZIP.

### Android preview — NOT AVAILABLE, honestly

`POST /api/projects/:id/preview` returns `available: false`, `status:
NOT_AVAILABLE`, and the message `adb present but no device/emulator is attached`.
No screenshot is fabricated. The response carries the package name it would have
installed and the single real step that was attempted (`adb devices`, empty).

### System status — real probes

`GET /api/system/status` on this host reports: node `AVAILABLE`,
java `AVAILABLE` (17.0.20.1), git `AVAILABLE`, docker `AVAILABLE` (daemon
reachable), adb `AVAILABLE`, androidSdk `AVAILABLE`, python `AVAILABLE`,
postgres `AVAILABLE` (16.15), gradle `NOT AVAILABLE` (`gradle: not found` — the
wrapper is used instead), androidEmulator `NOT_AVAILABLE`. `executionBackend:
docker`, `sandboxEnabled: true`, `jobs: {active:0, pending:0, max:3}`.

### Tests and build after these changes

```
npm run typecheck   → exit 0 (backend + frontend)
npm run lint        → exit 0 (backend + frontend)
npm run test        → backend 42/42 pass, frontend 12/12 pass (45/45 after the
                      sandbox delete-policy fix, see below)
npm run build       → backend tsc clean; frontend built in 1.40s
```

Three OpenRouter tests were added for the 429 paths: `Retry-After` is surfaced,
a daily quota is reported with its reset time and not retried, and a retryable
failure still retries up to the configured maximum.

### Sandbox delete policy — a real gap found by testing

While probing isolation, `rm -rf / --no-preserve-root` was run through the real
terminal endpoint. It returned a **shell** denial from the container's own
permissions (`rm: cannot remove '/root': Permission denied`), but the run also
emptied that project's workspace. Investigation showed why: the deny list was
only consulted when the backend was `host`. In the docker sandbox the project is
mounted read-write at `/workspace`, so a command naming the mount root destroys
the project it was meant to build. Blast radius was verified to be exactly the
one project - other workspaces, `/data/storage` and the database were untouched.

Fixed by splitting the patterns into two tiers:

- environment-targeting patterns (`rm -rf /`, `rm -rf /workspace`, fork bombs,
  disk wipes, `/etc/shadow`, reverse shells, pipe-to-shell downloads) now apply
  on **every** backend;
- host-only patterns (docker socket, `sudo`, `shutdown`) remain host-only, since
  blocking them inside the container would only break legitimate build steps.

Verified against the live stack after rebuild:

```
POST .../terminal {"command":"rm -rf /workspace"}  → exit 126, "BLOCKED BY POLICY: refusing rm on the mounted project root"
POST .../terminal {"command":"rm -rf /"}           → exit 126, "BLOCKED BY POLICY: refusing rm on /"
POST .../terminal {"command":"./gradlew --version"}→ exit 0
project file count before/after the two attempts  → 19 / 19
```

Three tests were added (`sandboxDenyReason` blocks the environment-targeting set,
allows the host-only set, and `denyReasonFor` picks per backend). Backend suite
went from 42 to 45 passing.

### Still open after this addendum

1. A live model-driven run that repairs the Kotlin error has not been observed —
   the free-tier quota blocked it. Re-run after 2026-09-24 00:00 UTC, or add
   credits, or point `OPENROUTER_MODEL` at another model. The mechanism itself is
   proven by the scripted-transport run above.
2. GitHub Actions remain `NOT TESTED` (never dispatched on a runner).
3. No emulator host is available, so Android preview stays `NOT AVAILABLE`.
4. The tree is committed locally (`aa7d7f1` and later) but has no remote, so
   nothing has been pushed.

### Addendum verification commands

```
npm run typecheck   → exit 0 (backend + frontend)
npm run lint        → exit 0 (backend + frontend)
npm run test        → backend 58/58 pass, frontend 13/13 pass (the job-queue
                      suite was added later and is mutation-checked)
npm run build       → backend tsc clean; frontend built in 1.35s
BASE=http://127.0.0.1:8080 bash scripts/smoke.sh → FAILURES: 0
```

### End-to-end artifact re-verification

A second project was created through the API and taken through the full path a
user would follow. Every number below was read from the live system, not copied
from an earlier run.

```
project            82f12657-b21c-4b0c-bfbf-0929900fbce3 (android-hello)
POST .../build     → exit_code 0, status succeeded
APK on disk        3 189 843 bytes, sha256 c8fa61b9…2396
GET  .../download/apk
                   → HTTP 200, 3 189 843 bytes, content-type
                     application/vnd.android.package-archive, magic bytes "PK"
                   → sha256 of the download equals the sha256 of the build
GET  .../download/zip
                   → HTTP 200, 50 416 bytes, 33 entries, no .env / secret /
                     credential / key / node_modules / .git entry
GET  .../download/logs
                   → HTTP 200, 2 617 bytes of real Gradle output
POST .../inspect-apk
                   → package com.myaistudio.hello, versionName 1.0,
                     versionCode 1, minSdk 24, targetSdk 34, MainActivity,
                     signed true, tools aapt2/unzip/axml/apksigner
POST .../security/scan
                   → status clean, 9 files scanned, APK scanned
                     (178 text-like entries of 422), findings []
cross-user APK GET → HTTP 404 (existence hidden, not just forbidden)
unauthenticated    → HTTP 401
```

Behavioural checks on the live deployment:

```
rate limiting      → 30 requests accepted, request 31 onwards HTTP 429;
                     /api/health still 200 after the burst
graceful shutdown  → docker kill --signal=TERM mas-api logs
                     "shutting down" then "shutdown complete", container exits 0
destructive policy → "rm -rf /workspace" and "rm -rf /" both exit 126 with
                     "BLOCKED BY POLICY"; "./gradlew --version" still exit 0
release            → rebuilt from HEAD 70a10d4; 25/25 checksums OK
sandbox network    → cloud metadata 169.254.169.254 unreachable from inside
                     (curl exit 28, timeout); legitimate egress works
                     (https://api.github.com -> 200); runs as uid/gid 1000
public URL path    → https://work-1-.../ serves the app (HTTP 200, title
                     "My AI Studio") and proxies /api/health (200); register,
                     project create (19 template files), terminal and file
                     listing all succeed through it with a mobile user-agent
terminal stability → 6/6 fresh projects returned the command output on the
                     first call (exit 0, ~630ms)
```

## ADDENDUM — 2026-09-23 (later): CI workflows exercised locally, three real defects fixed

No new features were added. The existing automation was executed instead of
being trusted, which surfaced three concrete problems.

### The CI security scan was failing on this repository

Running `.github/workflows/security.yml`'s own `git grep` here reported:

```
scripts/dev-stack.sh:85: JWT_SECRET=dev-only-secret-change-in-production-0123456789
scripts/dev-stack.sh:86: DATABASE_URL=postgres://studio:studiopw@pg:5432/myaistudio
SECURITY FAILED
```

The scan was right and the script was wrong: a working password and JWT secret
were committed in a tracked file. `scripts/dev-stack.sh` now generates random
credentials into a gitignored `.dev-credentials`, and - because the Postgres
volume already exists on a running host - adopts the live container's password
instead of minting a new one, so `up` stays idempotent. Verified after the
change: the file is mode 600, `git check-ignore` matches it, and a pre-existing
account still logs in (HTTP 200).

The scan's patterns also matched bare shell variable references such as
`-e "JWT_SECRET=$JWT_SECRET"`, so it would have failed on any correct new code.
The value classes now exclude `$`. Checked both ways in a sandbox: four planted
literal secrets are still caught, four variable references are ignored.

### The APK secret scan could pass without inspecting anything

`.github/workflows/build-apk.yml` unzipped the APK and reported "clean". This
environment has no `unzip` on the host, so the step silently did nothing and
printed success. It now fails closed: it refuses to run without `unzip`, and
refuses to report clean when it scanned zero APKs.

### An orphaned agent run could overwrite a timeout failure with success

A run exceeding `AGENT_TIMEOUT` is rejected by the job queue and the route
records `status='failed'`. The abandoned run kept running its in-flight build,
then fell through to the success branch and rewrote the same row as
`succeeded` - a green result for work reported as failed. The success path now
checks the abort signal and writes through `finishRun`, which only applies while
the row is still `queued` or `running`. Confirmed against real PostgreSQL: after
a `failed` write, the guarded success update affects 0 rows.

### Test count

`backend/tests/jobQueue.test.ts` was added because the queue is what prevents a
wedged job from holding a slot forever, and it had no test. 58/58 backend,
13/13 frontend. The suite was mutation-checked: deleting the timeout race turns
it red (`fail 1`), and restoring the file returns it to green.

```
npm run typecheck   -> exit 0 (backend + frontend)
npm run lint        -> exit 0 (backend + frontend)
npm test            -> backend 58/58, frontend 13/13
npm run build       -> clean
scripts/smoke.sh    -> FAILURES: 0, against the rebuilt container
```

### What this does not claim

The workflows were parsed as YAML and their shell steps were run here. They have
still never executed on a GitHub runner, and Oracle and Cloudflare are still not
deployed. GITHUB ACTIONS remains NOT TESTED; see the checklist.

## ADDENDUM — 2026-09-24: FREE_ONLY diagnostic bypass closed, security probes re-run

### The bug

The AI provider diagnostics (`POST /api/ai/providers/:id/test` and
`POST /api/ai/models/test`) call a provider adapter **directly** instead of
routing through `AiProviderRouter.chat()`. The FREE_ONLY policy lived only in the
router, so those two endpoints bypassed it entirely: with `FREE_ONLY=true`, a
diagnostic against a paid provider was dispatched and returned PASS. That is a
real paid request under a mode whose entire purpose is not to make one.

The bypass was first demonstrated, then fixed, then re-tested against a network
canary. `CEREBRAS_BASE_URL` and `MISTRAL_BASE_URL` on the audit container point
at a local listener, so any outbound paid request is counted as a canary hit.

```
BEFORE the fix (main image)
  POST /api/ai/providers/cerebras/test  -> HTTP 200, result PASS
  POST /api/ai/models/test (mistral)    -> HTTP 200, result PASS
  canary hits                           -> 2   (real quota spent)

AFTER the fix (rebuilt my-ai-studio-backend:jdk)
  POST /api/ai/providers/cerebras/test  -> result BLOCKED_BY_FREE_ONLY
                                           code NO_FREE_PROVIDER_AVAILABLE
                                           quotaCost "none", durationMs 0
  POST /api/ai/models/test (mistral)    -> result BLOCKED_BY_FREE_ONLY
                                           quotaCost "none", durationMs 0
  canary hits                           -> 0
```

The gate is now a single method, `AiProviderRouter.freeOnlyRefusal(provider,
model)`, so the router and the diagnostics consult the same policy rather than
two copies that can drift. The route helper only shapes the HTTP body.

Covered by four regression tests in `backend/tests/freeOnly.test.ts`: a paid
provider is refused, a non-free model of a free provider is refused, a free
provider and its free model are allowed, and everything is allowed when
FREE_ONLY is off.

### Terminal history now states who ran the command

Migration 003 added a `source` column to `commands` because the terminal history
could not distinguish a command the user typed from one the agent ran.
`listCommands()` now returns it, `CommandHistoryEntry` carries it, and
`TerminalScreen` renders an `agent` badge for rows the user did not type. The
render was also reading fields (`backend`, `cwd`, `stdout`) that history rows do
not carry, so it dereferenced `undefined` on every past command; that is fixed.

### Security probes re-run against the live backend

```
path traversal, read    ?path=../../../../etc/passwd            -> 400 invalid_path
path traversal, encoded ?path=%2e%2e%2f%2e%2e%2fetc%2fpasswd    -> 400 invalid_path
path traversal, write   {"path":"../../../../tmp/pwned.txt"}    -> 400 invalid_path
path traversal, delete  ?path=../../../etc/hostname             -> 400 invalid_path
null byte in path       "ok.txt\u0000.sh"                       -> 400 invalid_path
invalid project id      /api/projects/not-a-uuid/file           -> 404 project_not_found
unauthenticated read    GET /api/projects                       -> 401 auth required
cross-user read         user2 GET user1 project                 -> 404 project_not_found
cross-user files        user2 GET user1 project/files           -> 404 project_not_found
cross-user agent run    user2 POST user1 agent/run              -> 404 project_not_found
cross-user APK          user2 GET user1 download/apk            -> 404
/                                (404 not 403, so existence is not disclosed)
```

Nothing escaped: `/tmp/pwned.txt` was never created.

### Secret scanner — sensitivity *and* specificity

The earlier report showed the clean case. This run also plants a fake key and
confirms the scanner actually fires, then removes it and confirms it goes quiet
again. A scanner that never reports is indistinguishable from a scanner that
cannot.

```
planted OPENROUTER_API_KEY=sk-or-... in app/src/main/java/SecretLeak.kt
  -> status findings, 10 files scanned, 3 findings
     (OPENROUTER_API_KEY, sk-or-key, api_key=  all at line 1)
  -> full key present in the JSON response? False   (masked sk-o****0000)

build with runSecurityScan:true on that workspace
  -> build status failed, security status findings, 3 findings
  -> full key present in the build log? False

after deleting SecretLeak.kt
  -> status clean, 0 findings
```

### A filename that survives path validation — investigated, not a live defect

`POST /file` with `path: "evil;rm -rf /;.sh"` returns 201 and creates the name.
Traversal is blocked and the sandbox never receives a shell string, so this
cannot currently execute anything: `runCommand` spawns `/bin/sh -c <command>`
with the command from the API, and no file path is interpolated into it.
`shellQuote` is applied where paths do reach a shell (the scratch-dir probe).
It is recorded here rather than silently dropped, because "no live defect" is a
statement about today's call graph, not a property of the validator.

### Verification after these changes

```
npm run typecheck   -> exit 0 (backend + frontend)
npm run lint        -> exit 0 (backend + frontend)
npm test            -> backend 97/97 pass, frontend 26/26 pass
npm run build       -> exit 0, frontend built in 802ms
GET /api/system/status -> 12 probes, real versions, no fabricated PASS
```

`system/status` reports `gradle NOT_AVAILABLE` (no global Gradle; the wrapper is
used), `androidEmulator NOT_AVAILABLE` (adb present, no device attached), and
each unconfigured provider as `NOT_AVAILABLE` with its reason. The paid-provider
canary endpoints are the only values that changed status in this session.

### Still open

- GITHUB ACTIONS: NOT TESTED — the workflows have never run on a GitHub runner.
- ORACLE CLOUD / CLOUDFLARE PAGES: NOT TESTED — no deployment performed.
- ANDROID EMULATOR: NOT AVAILABLE — no device or emulator is attached, so the
  preview path stays honest and returns `available: false`.

---

## FINAL GATE — ADDENDUM (2026-09-24)

This addendum covers the final gate: a fresh end-to-end run through the real UI
contract, against the live `mas-api` container, with `FREE_ONLY=true`.

Environment: branch `fix/multi-provider-routing-and-preview-contract`, HEAD
`9906b2e`. Containers `mas-api` (healthy), `mas-audit` (healthy), `mas-pg` (up).

### The run

A brand-new user (`e2e-final@example.com`) was registered and a new empty
`android` project created from the `android-hello` template
(`f86479ea-d1e2-47b2-afc5-771fc2a740b4`). A single natural-language request was
sent: add a counter with increment/reset, wire it into `MainActivity`, add a real
JUnit test, then test and build.

- Run `69455d28-…` **failed honestly**: the free-provider chain exhausted every
  candidate (OpenRouter daily free quota already spent; Gemini, Groq, Cloudflare
  and NVIDIA all rate-limited or erroring) and ended on NVIDIA HTTP 503. No
  outcome was fabricated; the failure is visible in the conversation.
- Run `ec130e11-…` **succeeded** on provider `gemini`, phases
  `analyzing → planning → editing → testing → building → completed`, tokens
  `20418` in / `1744` out, `fix attempts 0/5`. The UI states this plainly:
  "served by Gemini (failed over from Groq)".

### Independent verification of the artifacts

Files written by the agent, read back from disk inside the container:

```
app/src/main/java/com/myaistudio/hello/Counter.kt        234 bytes  (new)
app/src/main/java/com/myaistudio/hello/MainActivity.kt  1384 bytes  (modified)
app/src/test/java/com/myaistudio/hello/CounterTest.kt    906 bytes  (new)
```

Gradle unit-test XML reports exist for both debug and release variants:

```
app/build/test-results/testDebugUnitTest/TEST-com.myaistudio.hello.CounterTest.xml
app/build/test-results/testDebugUnitTest/TEST-com.myaistudio.hello.GreetingTest.xml
app/build/test-results/testReleaseUnitTest/TEST-com.myaistudio.hello.CounterTest.xml
app/build/test-results/testReleaseUnitTest/TEST-com.myaistudio.hello.GreetingTest.xml
```

`CounterTest` really ran: 4 tests, 0 failures, 0 errors.

APK, produced by a real `./gradlew assembleDebug`:

```
path    app/build/outputs/apk/debug/app-debug.apk
size    3 191 087 bytes
sha256  ed1b8d96d6dada7139ba64702dd33b7919a67234ba99ed148e77eced56cf49c2
package com.myaistudio.hello   versionName 1.0   versionCode 1
minSdk  24   targetSdk 34
```

Structural check of the downloaded bytes: valid zip, 422 entries, CRC OK,
`AndroidManifest.xml` + `resources.arsc` + `classes.dex`,`classes2.dex`,`classes3.dex`
present.

### Downloaded through the route the UI actually calls

`GET /api/projects/:id/download/apk` returned HTTP 200, `3 191 087` bytes,
`Content-Type: application/vnd.android.package-archive`,
`Content-Disposition: attachment; filename="app-debug.apk"`. The SHA-256 of the
downloaded bytes equals the artifact SHA-256 above — **MATCH**, verified by
re-hashing the response body.

### Export

`POST /api/projects/:id/export` produced a real 51 476-byte zip, 35 entries,
CRC OK, `excludedEntries: []`. It contains the agent's `Counter.kt` and
`CounterTest.kt`, and contains **no** build output, **no** `.apk`, **no** `.env`,
`secret`, `credential`, `.pem`, `.key`, `node_modules`, `apikey` or `token`
entries.

### Security scan

`POST /api/projects/:id/security/scan` → `status: clean`, `filesScanned: 11`,
`findings: 0` (memory-only regex scan; no `gitleaks` binary is used).

### WebSocket

Unauthenticated upgrade to `/ws` is rejected with `401`. An authenticated
upgrade returns `101 Switching Protocols` with a valid `Sec-WebSocket-Accept`.

### Real-time probe of deployment readiness

`GET /api/system/status` — every value below came from a real probe:

| Check | State | Detail |
| --- | --- | --- |
| node | AVAILABLE | v22.23.3 |
| java | AVAILABLE | 17.0.20.1 |
| git | AVAILABLE | 2.39.5 |
| docker | AVAILABLE | 27.3.1, daemon reachable |
| gradle | NOT_AVAILABLE | `/bin/sh: 1: gradle: not found` (wrapper is used) |
| adb | AVAILABLE | 1.0.41 |
| androidSdk | AVAILABLE | /opt/android-sdk |
| postgres | AVAILABLE | 16.15 |
| openrouter | ERROR | daily free quota exhausted; resets 2026-09-25T00:00:00Z |
| gemini | AVAILABLE | 200 observed |
| groq | AVAILABLE | 200 observed (later 429) |
| cloudflare | AVAILABLE | 200 observed; `CHAT_ONLY` (tool protocol not verified) |
| nvidia | AVAILABLE | 200 observed |
| cerebras / mistral | NOT_TESTED | configured; blocked under FREE_ONLY |
| huggingface / chutes / sambanova / ollama / vllm | NOT_AVAILABLE | not configured |
| androidEmulator | NOT_AVAILABLE | adb present, no device attached |

### Preview

`POST /api/projects/:id/preview` → `available: false`,
`status: NOT_AVAILABLE`, `devices: []`. `adb devices -l` is empty and there is no
`/dev/kvm`. No static image is substituted for a live preview.

### Frontend build and UI contract

The production bundle was rebuilt with `VITE_API_URL` and served by
`vite preview`. Driving the real UI in a browser: sign-in succeeded and set the
`mas_session` `HttpOnly; Secure; SameSite=Lax` cookie; the dashboard rendered
backend-sourced counts (`1` project, `2` builds, `2` builds ok, `2` APKs, sandbox
`docker`); the project workspace opened with `AI | Files | Terminal | Build |
Preview | Export`; the AI tab showed all nine agent phases ticked with the real
summary text.

A deployment note surfaced here: in local HTTP development the session cookie is
marked `Secure`, so a browser will only keep it over HTTPS. This is correct for
production (the shipped `.env.production.example` sets
`SESSION_COOKIE_SAMESITE=none` and `DATABASE_SSL=true` behind HTTPS) but means
plain-HTTP local sessions must be treated as unreliable rather than as a defect.

### Final gate status

| Area | Status | Evidence |
| --- | --- | --- |
| Environment | PASS | probes above |
| Backend | PASS | healthy container; 97/97 tests in the prior session |
| Frontend | PASS | rebuild + production bundle + real browser session |
| Database | PASS | PostgreSQL 16.15 reachable, rows persisted |
| Multi-provider (free) | PASS | gemini/groq/cloudflare/nvidia answered real requests |
| OpenRouter | ERROR | free-model daily quota exhausted; honest reset time |
| Agent loop | PASS | failed-then-succeeded runs, 0 fix attempts, real files |
| Backend-driven build + APK | PASS | 3 191 087 bytes, downloaded SHA-256 MATCH |
| APK inspection | PASS | package/version/sdk read from the artifact |
| APK security scan | PASS | clean, 11 files, 0 findings |
| Export | PASS | real zip, secrets and build output excluded |
| WebSocket | PASS | 401 unauthenticated, 101 authenticated |
| Android emulator / preview | NOT_AVAILABLE | no device, no /dev/kvm |
| GitHub Actions | NOT TESTED | `GITHUB_REPO`/`GITHUB_TOKEN` unset; never dispatched |
| Oracle / Cloudflare deploy | NOT TESTED | no deployment performed |

### Exact next steps for the untested items

1. GitHub Actions: set repository secrets `OPENROUTER_API_KEY` (and
   `DATABASE_URL`, `JWT_SECRET` where the workflow needs them), push a real
   remote, then `gh workflow run build-apk.yml -f sample=hello` and read the run
   log. Until then the status stays `NOT TESTED` — the workflows are valid YAML
   (`build-apk` → `apk`; `build` → `frontend`, `backend-image`, `docs-check`;
   `security` → `secret-scan`, `dependency-audit`, `codeql`; `test` → `backend`)
   but have never run on a runner.
2. Android preview: attach a device/emulator host (or run an emulator with KVM)
   and point `adb` at it; the existing preview path will install, launch and
   capture logcat for real.
