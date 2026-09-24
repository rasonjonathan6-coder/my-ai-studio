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
| Backend tests | PASS | `npm test` - 58 tests, 58 pass; the job-queue suite is mutation-checked (removing the timeout race turns it red) |
| Backend build (`tsc`) | PASS | emits `backend/dist/server.js` |
| Frontend typecheck | PASS | `tsc --noEmit` clean |
| Frontend lint | PASS | `eslint` clean |
| Frontend tests | PASS | `vitest run` - 13 tests, 13 pass |
| Frontend production build | PASS | `vite build` emits `frontend/dist` |
| Bundle contains no secrets | PASS | grep of `dist/` for key patterns is empty |

## Runtime

| Item | State | Evidence |
| --- | --- | --- |
| Database migrations | PASS | 13 tables created; asserted by querying `information_schema` |
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
| Docker sandbox | PASS | commands ran in the sandbox image as uid 1000 with no socket |

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
| CI APK workflow | NOT TESTED | `.github/workflows/build-apk.yml` is written but has not run here |

## Operations

| Item | State | Evidence |
| --- | --- | --- |
| Docker Compose stack | PASS | builds and starts; verified with a real container |
| Sandbox image | PASS | built and ran isolation checks |
| Secret scan in CI | PASS | the workflow's own scan steps were executed here against this tree; they now pass, and were checked to still catch planted literal secrets while ignoring `$VAR` references |
| GitHub Actions workflows | NOT TESTED | valid YAML (parsed with `js-yaml`), correct `master` trigger and locally executed scan steps; still never dispatched on a real runner |
| GitHub workspace publish | PASS (unit) / BLOCKED (live) | the Git Data API sequence, `base_tree` preservation and managed-workflow install are asserted against a local HTTP server (`CASE 3`); a real publish to `rasonjonathan6-coder/app` is refused with `403` by the read-only installation token, and the route reports that verbatim instead of claiming a publish |
| GitHub workflow dispatch | PASS (unit) / BLOCKED (live) | a refused publish aborts before any commit (`CASE 3b`) and dispatch is skipped with the 403 reason; `GET /api/system/github` reports `canWrite: false`, probed with a real dangling-blob write |
| GitHub write capability probe | PASS | `canWrite` distinguishes a read-only credential from a writable one; verified live as `false` |
| Oracle Cloud deployment | NOT TESTED | no Oracle access; see `ORACLE_SETUP.md` |
| Cloudflare Pages deployment | NOT TESTED | no Cloudflare access; see `CLOUDFLARE_SETUP.md` |
| Supabase connection | NOT TESTED | no Supabase project; uses local PostgreSQL |
| Backup job | NOT CONFIGURED | procedure documented, no scheduler installed |
| Monitoring / alerting | NOT CONFIGURED | logs only, no external monitor |

## Go-live gate

Before exposing this to anyone else, all of the following must be true:

- [ ] `JWT_SECRET` is a real 32+ character random value. The helper script now
      generates one into a gitignored `.dev-credentials`, so no placeholder is
      committed; production must supply its own via the environment.
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
