# My AI Studio

A web platform that lets you ask an AI agent to create, edit, test, build and
export software projects - including real Android apps - from a phone browser.

Three claims define this project, and everything in it is written to keep them
true:

1. **Nothing is simulated.** When the UI says a build succeeded, a real Gradle
   process produced a real APK file on disk, and the backend verified it exists
   before reporting success.
2. **When something cannot be done, the system says so.** Missing toolchain,
   absent API key, no emulator: each of those surfaces as
   `NOT AVAILABLE` / `NOT CONFIGURED` rather than a plausible-looking fake.
3. **Secrets stay on the server.** The OpenRouter key, the database URL and the
   JWT secret are read from the server environment only. They are redacted from
   logs, excluded from exports, and never shipped to the browser.

## What actually works

Verified in this environment (see `FINAL_REPORT.md` for the full evidence):

| Capability | State |
| --- | --- |
| Backend API, auth, project isolation | Working |
| PostgreSQL schema + migrations (13 tables) | Working |
| Real terminal execution (stdout/stderr/exit code) | Working |
| WebSocket event streaming | Working |
| Gradle unit tests + `assembleDebug` | Working |
| APK inspection (aapt2 / apksigner, built-in AXML parser fallback) | Working |
| Secret scanning of sources and APK | Working |
| Project ZIP export with exclusions | Working |
| Frontend (Vite + React + TS) | Working |
| Agent tool loop + fix/rebuild cycle | Working |
| OpenRouter LLM calls | Code complete, `NOT CONFIGURED` (no API key here) |
| Docker sandbox for commands | Working with `SANDBOX_ENABLED=true` (needs a Docker socket) |
| Android emulator preview | Code complete, `NOT AVAILABLE` (no emulator here) |

## Layout

```
backend/            Node + TypeScript API, agent loop, WebSocket, build services
frontend/           Vite + React + TypeScript PWA-style UI (mobile-first)
android-samples/    Three real Android projects built in CI (generated)
scripts/            smoke.sh, generate-android-samples.mjs, checksums
docs/               operational documentation
.github/workflows/  test.yml, build.yml, build-apk.yml, security.yml
```

## Quick start (local)

```bash
# 1. Database
sudo service postgresql start

# 2. Backend
cd backend
cp .env.example .env          # then edit DATABASE_URL / JWT_SECRET
npm install
npm run migrate
npm run dev                   # http://127.0.0.1:8080

# 3. Frontend (new shell)
cd frontend
npm install
npm run dev                   # http://127.0.0.1:5173, proxies /api and /ws
```

Open the frontend URL, register an account, create an `android-calculator`
project, then in the project's Build tab press **RUN TESTS** and
**BUILD DEBUG APK**.

## Verifying it is real

```bash
bash scripts/smoke.sh
```

The smoke script exercises the running server over HTTP: it registers a user,
creates an Android project, reads a file, attempts a path traversal (which must
be rejected), runs a terminal command, runs the Gradle suite, asserts that real
JUnit XML reports were parsed with a non-zero pass count, builds the APK,
inspects it, exports a ZIP, and confirms cross-user and unauthenticated access
are denied. Every line prints `PASS` or `FAIL` from an actual HTTP response.

## Configuration

Copy `backend/.env.example` and set what you have. Nothing is mandatory except a
database and a session secret; everything else degrades to a reported
`NOT CONFIGURED` state rather than breaking startup.

| Variable | Purpose | If unset |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection | startup fails loudly |
| `JWT_SECRET` | session signing | generated per process, warned at boot |
| `OPENROUTER_API_KEY` | LLM access | agent reports `not_configured` |
| `OPENROUTER_MODEL` | model id | defaults to `openrouter/free` |
| `SANDBOX_ENABLED` | run commands in Docker | falls back to host backend, reported as such |

`VITE_API_URL` is the only frontend variable and must never hold a secret.

## Documentation

- `ARCHITECTURE.md` - components and data flow
- `SECURITY.md` - threat model and controls
- `DEPLOYMENT.md` - production deployment overview
- `ORACLE_SETUP.md`, `CLOUDFLARE_SETUP.md`, `SUPABASE_SETUP.md` - provider specifics
- `GITHUB_ACTIONS.md` - what each workflow really does
- `OPENROUTER_SETUP.md` - obtaining and configuring a key
- `PRODUCTION_CHECKLIST.md` - go-live checklist
- `TROUBLESHOOTING.md` - common failures and real causes

## Licence

Not specified. Treat as all rights reserved until a licence is added.
