# Production checklist

Mark each item with one of four values, and mean it:

- **PASS** - actually executed and verified here, with the command or artifact shown
- **FAIL** - executed and it went wrong
- **NOT AVAILABLE** - the capability does not exist in this environment
- **NOT TESTED** - possible, but nobody has run it yet

Never write PASS because it should work. The states below reflect what was run
while building this repository; re-verify on your own machine, since they depend
on that machine's toolchain.

## Build

| Item | State | Evidence |
| --- | --- | --- |
| Backend typecheck | PASS | `npm run typecheck` clean |
| Backend lint | PASS | `npm run lint` clean |
| Backend tests | PASS | `npm test` - 196 tests, 196 pass; the job-queue suite is mutation-checked (removing the timeout race turns it red) |
| Backend build (`tsc`) | PASS | emits `backend/dist/server.js` |
| Frontend typecheck | PASS | `tsc --noEmit` clean |
| Frontend lint | PASS | `eslint` clean |
| Frontend tests | PASS | `vitest run` - 31 tests, 31 pass |
| Frontend production build | PASS | `vite build` emits `frontend/dist` |
| Bundle contains no secrets | PASS | grep of `dist/` for key patterns is empty |

## Runtime

| Item | State | Evidence |
| --- | --- | --- |
| Database migrations | PASS | 13 tables created; asserted by querying `information_schema` |
| Database connectivity assertion | PASS | `scripts/deploy-production.sh` reads the `postgres` probe from `/api/system/status` (a real `SELECT version()`) and fails instead of reporting PASS when it is not `AVAILABLE`. Added after the script passed a stack whose database was unreachable — see the 2026-09-24 addendum in `FINAL_REPORT.md` |
| Authentication (register/login/logout/me) | PASS | exercised by `scripts/smoke.sh` |
| Project authorization | PASS | a second account gets 404 for another user's project, on both project metadata and every download route; the 404 is deliberate so ids cannot be probed (an audit row is still written) |
| Unauthenticated access denied | PASS | unauthenticated `GET /api/projects/:id/download/apk` returns 401; smoke asserts it |
| Path traversal blocked | PASS | unit tests plus a live request in the smoke suite |
| Real terminal execution | PASS | stdout/stderr/exit code/duration returned |
| Destructive-command policy | PASS | `rm -rf /` and `rm -rf /workspace` both return exit 126 with `BLOCKED BY POLICY` on the docker backend; the project keeps its files and `./gradlew --version` still runs |
| WebSocket event stream | PASS | live run delivered `connected`, `build_log` (429 backoff) and `agent_status` events to a real client |
| Rate limiting | PASS | limiter middleware active on API, auth, terminal, agent, build |
| Graceful shutdown | PASS | SIGTERM/SIGINT close server, sockets and pool |
| Health endpoint | PASS | `GET /api/health` returns `{"ok":true,...}` |
| System status probes | PASS | `GET /api/system/status` reports each component |
| OpenRouter integration | PASS | live key configured; HTTP 200 completion; `/api/health` reports `configured`; daily-quota 429 handled honestly |
| Multi-provider routing (OpenRouter/Gemini/Groq) | PARTIAL | `GET /api/ai/providers` and `/api/ai/providers/:id/test` run against the real provider APIs; OpenRouter reports `rate_limited · HTTP 429` while its free-model daily quota is exhausted, and Gemini/Groq report `NOT_CONFIGURED` because no server key is set. AUTO fails over only on temporary limits, never on a bad credential |
| Provider key isolation | PASS | provider keys are read server-side only; the test endpoint masks them and no key reaches the frontend bundle or an attempt record |
| Android preview endpoint | NOT AVAILABLE | real `adb devices` probe returns no attached device; the endpoint answers `ANDROID PREVIEW: NOT AVAILABLE` and the UI shows no mocked frame |
| Agent loop (real tools) | PASS | run reached `succeeded`; source file repaired on disk and APK hash matched the inspection record |
| Docker sandbox | PASS | commands ran in the sandbox image as uid 1000 with no socket; a live `node --version` returned the image's v18, not the host's v22 |
| Production stack (`docker-compose.prod.yml`) | PASS | deployed and verified end to end by `scripts/deploy-production.sh`: frontend 200, `/api/health` 200, unauthenticated 401, `executionBackend: docker`, served bundle free of secrets |
| Public HTTPS reachability | PASS | served through the platform's HTTPS edge; register 201, project create 201, WebSocket `connected` frame received, unauthenticated and cross-user reads 401 |
| Sandbox secret isolation | PASS | from inside the sandbox, `cat /.env` says no such file, `ls /data` says no such file, and `env \| grep -iE 'OPENROUTER\|JWT\|DATABASE'` is empty; `/proc/1/environ` is refused (HTTP 500) |
| Sandbox workspace mount | PASS | the project's real files are visible at `/workspace` in the sandbox and `npm install && npm test` ran there with exit 0 |
| Production sandbox fail-closed | PASS | `resolveBackend` refuses instead of falling back to the host when the daemon is unreachable or the image is missing; 5 tests cover it, and the startup log reports `executionBackend: unavailable` in that state |
| Production guard regression | PASS | `backend/tests/productionGuard.test.ts` - 8 tests, 8 pass |

## Android

| Item | State | Evidence |
| --- | --- | --- |
| Android SDK present | PASS | `aapt2`/`apksigner` from `build-tools;34.0.0` |
| Gradle unit tests | PASS | Gradle 8.9, real JUnit XML parsed, non-zero pass count |
| `assembleDebug` | PASS | APK produced on disk |
| APK exists and is valid | PASS | `aapt2 dump badging` on the file |
| APK inspection | PASS | package/version/minSdk/targetSdk/components read from the built APK; values match `aapt2 dump badging` |
| APK secret scan | PASS | read with the in-process ZIP reader (no system `unzip`); 178 of 422 entries scanned; clean; a key planted inside an APK was detected and masked, never echoed in full |
| Failed build reports no artifact | PASS | broken Kotlin source → `status: failed`, `apk: null`, zero `apk produced` log lines |
| Emulator preview | NOT AVAILABLE | no emulator, no KVM; endpoint reports `ANDROID PREVIEW: NOT AVAILABLE` |
| CI APK workflow | PASS | `.github/workflows/android-build.yml` dispatched on a GitHub-hosted runner; job `success`, artifacts `app-debug-apk` (3 189 843 bytes) and `test-reports` |

## Operations

| Item | State | Evidence |
| --- | --- | --- |
| Docker Compose stack | PASS | builds and starts; verified with a real container |
| Sandbox image | PASS | built and ran isolation checks |
| Secret scan in CI | PASS | the workflow's own scan steps were executed here against this tree; they now pass, and were checked to still catch planted literal secrets while ignoring `$VAR` references |
| GitHub Actions workflows | PASS | five workflows valid YAML; `android-build.yml` dispatched on a real runner and the job ran to `success` (JDK, Android SDK, tests, `assembleDebug`, APK locate, artifact upload) |
| GitHub workspace publish | PASS (live) | `POST /api/projects/:id/github/sync` returned HTTP 200 pushing 15 files to `rasonjonathan6-coder/app` (commit `8a9eb825b323…`) and installed the managed workflow on the default branch; the Git Data sequence, `base_tree` preservation and install are also asserted in `CASE 3`/`CASE 3c` |
| GitHub workflow dispatch | PASS (live) | `POST /api/projects/:id/github/build` returned HTTP 202, `status: queued`; run `36030411740` reached `success`; the APK (3 189 843 bytes) and the 81 KB run log were fetched back through My AI Studio's own routes |
| GitHub write capability probe | PASS | `canWrite` distinguishes a read-only credential from a writable one; seen `true` under the writable credential used for the publish above. The credential now in this environment is read-only and reports `canWrite: false`, so publish and dispatch are refused with an actionable 403 (see `FINAL_REPORT.md`, 2026-09-24 addendum) |
| Oracle Cloud deployment | NOT TESTED | no Oracle access; see `ORACLE_SETUP.md`. The production stack itself is deployed and verified (rows above) on a different host, so the remaining Oracle-specific step is provisioning the VM |
| Cloudflare Pages deployment | NOT TESTED | no Cloudflare access; see `CLOUDFLARE_SETUP.md` |
| Supabase connection | NOT TESTED | no Supabase project; uses local PostgreSQL |
| Backup job | NOT CONFIGURED | procedure documented, no scheduler installed |
| Monitoring / alerting | NOT CONFIGURED | logs only, no external monitor |

## Go-live gate

Before exposing this to anyone else, all of the following must be true:

- [ ] `JWT_SECRET` is a real 32+ character random value. The helper script now
      generates one into a gitignored `.dev-credentials`, so no placeholder is
      committed; production must supply its own via the environment.
- [ ] `MY_AI_STUDIO_CREDENTIAL_KEY` is a separate real random value, so a
      credential stored through the admin API survives a restart and is not
      tied to the session signing key. Without it (or a real `JWT_SECRET`) a
      stored credential becomes undecryptable on every restart and the app
      logs `stored GitHub credential could not be decrypted`.
- [ ] `MY_AI_STUDIO_ADMIN_EMAIL` names an existing account when the database
      already has users, because the GitHub credential API is admin-only and a
      deployment with no admin cannot configure it.
- [ ] `DATABASE_URL` points at a real database with TLS (`sslmode=require`)
- [ ] `CORS_ORIGINS` lists your exact frontend origin, not `*`
- [ ] `SESSION_COOKIE_SAMESITE` matches your topology (`none` if cross-site)
- [ ] HTTPS terminates in front of the API
- [ ] The API port and PostgreSQL are unreachable from the internet
- [ ] `SANDBOX_ENABLED=true`, and you accept that this means mounting the Docker socket
- [ ] `/data/workspaces` and `/data/storage` are writable by uid 1000
- [ ] A backup job has been installed *and a restore has been tested*
- [ ] `bash scripts/smoke.sh` passes against the deployment

The restore test is the one people skip. A backup you have never restored is a
guess.

## What is deliberately not production-ready

- The host command backend (`SANDBOX_ENABLED=false`) runs commands as the
  service user with a denylist. It is a development fallback, not a security
  boundary. Use the sandbox in production.
- The Android preview returns "not available" rather than a fake screen. Wiring
  a real emulator host is future work, not a hidden gap.
- There is no multi-tenant resource accounting: `MAX_CONCURRENT_JOBS` caps total
  parallelism, not per-user usage.
