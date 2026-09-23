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
| FRONTEND | PASS | typecheck, lint, 12/12 tests, production build 432.05 kB JS / 116.64 kB gzip across 4 lazy chunks + 9.88 kB CSS; the app is served over the public work-host URL and its API proxy works from a mobile user-agent |
| BACKEND | PASS | typecheck, lint, 45/45 tests (incl. OpenRouter tests against a real local HTTP server), real HTTP smoke 15/15 |
| DATABASE | PASS | PostgreSQL 16.15 reachable; migrations applied; auth and project rows persisted and read back |
| OPENROUTER | PASS | live key used; HTTP 200 completion; `/api/health` reports `configured`; key never echoed |
| AGENT LOOP | PASS | live run: reading -> editing -> testing -> building -> completed; code change and APK independently verified |
| OPENHANDS | NOT AVAILABLE | no OpenHands agent-server endpoint reachable from this environment |
| DOCKER | PASS | backend image built; container ran; full smoke suite executed inside it; sandbox runs as uid 1000, cannot reach `169.254.169.254`, and legitimate egress still works |
| GITHUB ACTIONS | NOT TESTED | four workflows written; never dispatched on a runner |
| ANDROID SDK | PASS (host) | build-tools 34.0.0, platform-tools, adb on the host |
| ANDROID BUILD | PASS | `./gradlew test` and `./gradlew assembleDebug` ran for real |
| APK | PASS | each template built a real `app-debug.apk`; the APK currently shipped in `release/` is 3 189 843 bytes, SHA-256 `c8fa61b9654c84e1eed5281fbe163383916806cb179b53a82cdd79d2138c2396` |
| APK INSPECTION | PASS | real `aapt2` + `apksigner`: package/version/min-target read from the APK; signature verified as debug-signed with the v2 scheme |
| APK SECURITY SCAN | PASS | archive unzipped and pattern-scanned; a planted key was detected and masked, and the clean templates report `clean` |
| ANDROID EMULATOR | NOT AVAILABLE | no emulator, no `/dev/kvm`; `adb devices` is empty |
| EXPORT | PASS | project ZIP produced with exclusions applied; a planted `.env` and `credentials.json` were both absent from the archive |
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

### GITHUB ACTIONS — NOT TESTED

Four workflows exist and are real: `test.yml`, `build.yml`, `build-apk.yml`,
`security.yml`. They checkout, install, lint, test, build and upload artifacts,
and they fail when the underlying step fails. The APK job verifies that
`app/build/outputs/apk/debug/app-debug.apk` exists before uploading it and
fails the job when it does not. None of them has been dispatched on a GitHub
runner from this environment, so their status is NOT TESTED rather than PASS.

### ORACLE CLOUD DEPLOYMENT — NOT TESTED

No Oracle Cloud account or VM was reachable. `ORACLE_SETUP.md` documents the
full procedure. Nothing was deployed and nothing claims to be.

### GITHUB REPOSITORY

This working tree has no commit yet and no configured remote; `git rev-parse
HEAD` fails with `unknown revision`. Everything is present as untracked files.
Pushing was not performed.

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
npm run test        → backend 45/45 pass, frontend 12/12 pass
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
