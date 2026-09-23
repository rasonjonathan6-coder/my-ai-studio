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
| ENVIRONMENT | PASS | node 24.21.0, java 21 (host) / 17 (image), git 2.39.5, docker 29.8.1, gradle 8.9, adb 1.0.41, python 3.13.15 |
| FRONTEND | PASS | typecheck, lint, 12/12 tests, production build 195.97 kB JS / 59.59 kB gzip |
| BACKEND | PASS | typecheck, lint, 39/39 tests (incl. 12 OpenRouter tests against a real local HTTP server), real HTTP smoke 15/15 |
| DATABASE | PASS | PostgreSQL 16.15 reachable; migrations applied; auth and project rows persisted and read back |
| OPENROUTER | PASS | live key used; HTTP 200 completion; `/api/health` reports `configured`; key never echoed |
| AGENT LOOP | PASS | live run: reading -> editing -> testing -> building -> completed; code change and APK independently verified |
| OPENHANDS | NOT AVAILABLE | no OpenHands agent-server endpoint reachable from this environment |
| DOCKER | PASS | backend image built; container ran; full smoke suite executed inside it |
| GITHUB ACTIONS | NOT TESTED | four workflows written; never dispatched on a runner |
| ANDROID SDK | PASS (host) | build-tools 34.0.0, platform-tools, adb on the host |
| ANDROID BUILD | PASS | `./gradlew test` and `./gradlew assembleDebug` ran for real |
| APK | PASS | three templates each built a real `app-debug.apk`; release APK 3 191 115 bytes, SHA-256 `e6a99ba41f26cffdd179e478fa9d0d83c2923b086d68d30797766875a6bbd2ff` |
| APK INSPECTION | PASS | real `aapt2` + `apksigner`: package/version/min-target read from the APK; signature verified as debug-signed with the v2 scheme |
| APK SECURITY SCAN | PASS | archive unzipped and pattern-scanned; a planted key was detected and masked, and the clean templates report `clean` |
| ANDROID EMULATOR | NOT AVAILABLE | no emulator, no `/dev/kvm`; `adb devices` is empty |
| EXPORT | PASS | project ZIP produced with exclusions applied; a planted `.env` and `credentials.json` were both absent from the archive |
| RELEASE ARTIFACTS | PASS | `release/` with source tarball, docs, deployment files and a real APK; 24 SHA-256 checksums verify |
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
