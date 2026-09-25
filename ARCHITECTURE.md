# Architecture

## Components

```
        Phone browser (Chrome Android)
                  |
                  | HTTPS + WSS
                  v
        Frontend  -  Vite + React + TypeScript
                      no secrets, no direct DB access
                  |
                  | /api/*  and  /ws/projects/:id
                  v
        Backend   -  Node + TypeScript (Express + ws)
                  |
    +-------------+---------------+------------------+
    |             |               |                  |
    v             v               v                  v
 PostgreSQL   Workspace FS    Command runner     LLM client
 (13 tables)  per-project     host or Docker     OpenRouter
                               backend           (server-side)
```

## Why the split is where it is

The frontend is a static bundle. It holds a session cookie and nothing else.
Every privileged action is an HTTP call or a WebSocket subscription, so the
browser can never reach a file, a command, an API key or another user's data
directly.

The backend owns all trust decisions. It resolves every path through
`lib/paths.ts`, authorises every route by project ownership, and is the only
process that reads environment secrets.

## Backend modules

| Path | Role |
| --- | --- |
| `src/server.ts` | Express app, middleware chain, graceful shutdown |
| `src/ws/server.ts` | WebSocket server, per-project channels, auth on subscribe |
| `src/routes/*.ts` | HTTP surface: auth, projects, system, agent, downloads |
| `src/agent/loop.ts` | The agent loop: analyze, plan, edit, run, test, build, fix |
| `src/agent/tools.ts` | Tool implementations exposed to the model |
| `src/services/commandRunner.ts` | Real process execution, timeouts, output caps |
| `src/services/build.ts` | Gradle detection, `assembleDebug`, APK location |
| `src/services/apkInspect.ts` | APK inspection: aapt2/apksigner when present, built-in AXML parser otherwise |
| `src/services/tests.ts` | Test command detection and JUnit XML parsing |
| `src/services/securityScan.ts` | Secret pattern scanning of sources and APK |
| `src/services/export.ts` | ZIP creation with exclusions and checksums |
| `src/services/workspace.ts` | Filesystem operations confined to a project root |
| `src/services/templates.ts` | Project templates incl. three Android apps |
| `src/services/openrouter.ts` | OpenRouter client: timeouts, retries, error mapping |
| `src/services/systemStatus.ts` | Probes for Node, Java, Git, Docker, SDK, Gradle, DB, disk |
| `src/services/jobQueue.ts` | Bounded concurrency for build and agent jobs |
| `src/lib/axml.ts` | Binary AndroidManifest (AXML) parser |

## The agent loop

```
ANALYZE -> PLAN -> READ -> EDIT -> RUN -> TEST -> BUILD
                                            |
                                     succeeded? --yes--> DONE
                                            |
                                            no
                                            v
                                    INSPECT ERROR -> FIX -> (rebuild, up to MAX_FIX_ATTEMPTS)
                                            |
                              limit reached v
                                    MAX_FIX_ATTEMPTS_REACHED -> FAILED
```

Each arrow is a `logEvent(...)` call that reaches the browser over WebSocket, so
the step list in the UI reflects the backend's real position - never a timer. On
exhausting `MAX_FIX_ATTEMPTS` the run stops with an explicit terminal state.

### Tools the agent can call

`list_files`, `read_file`, `create_file`, `edit_file`, `delete_file`,
`search_code`, `run_command`, `run_tests`, `build_project`, `build_android`,
`inspect_build_error`, `inspect_apk`, `git_status`, `git_diff`.

When no LLM is configured the agent still runs: it reports
`LLM NOT CONFIGURED`, performs the read-only analysis it can (file listing,
search, toolchain probe) and stops. It does not invent a plan or fake an edit.

## Data model

Thirteen tables, created by `backend/migrations/001_init.sql`:

`users`, `projects`, `conversations`, `messages`, `agent_runs`, `commands`,
`builds`, `tests`, `artifacts`, `deployments`, `audit_logs`, `sessions`,
`schema_migrations`.

Every project-scoped table carries `project_id` with an index, and queries always
filter by the authenticated owner. Timestamps are `timestamptz`. Long logs are
stored truncated at a documented byte cap rather than unbounded.

## Request lifecycle for a build

1. `POST /api/projects/:id/build` - authorised against project ownership.
2. The job is queued in `services/jobs.ts`; concurrent long jobs are capped.
3. `services/build.ts` detects the Gradle task, runs `./gradlew assembleDebug`
   with a timeout, streaming output to the project WebSocket channel.
4. On exit 0 the service locates `app/build/outputs/apk/debug/*.apk` and stats
   it. If the file is absent the build is recorded as failed regardless of exit
   code, so an exit-0-with-no-artifact case can never be reported as success.
5. `apkInspect.ts` runs aapt2/apksigner when the SDK is present, and otherwise
   decodes the binary AndroidManifest with the built-in AXML parser
   (`src/lib/axml.ts`) for package, version, SDK levels, permissions and
   components. Nothing is inferred from raw strings, so absent data is null
   with a note rather than a wrong value.
6. `security.ts` scans the tree and the APK archive for secret patterns.
7. A `builds` row plus an `artifacts` row are written, and the response carries
   the real path, size and SHA-256.

## Frontend structure

| Path | Role |
| --- | --- |
| `src/App.tsx` | Shell: auth gate, top nav, bottom nav, view switch |
| `src/components/ProjectWorkspace.tsx` | Project shell: header, tab bar, socket |
| `src/screens/Ai.tsx` | Agent chat and real-time step list |
| `src/screens/Files.tsx` | File tree, reader, editor, search |
| `src/screens/Terminal.tsx` | Command entry, live stream, history |
| `src/screens/Build.tsx` | Environment probes, tests, APK build, scan |
| `src/screens/Export.tsx` | Preview screen and export screen |
| `src/hooks/index.ts` | Session, project socket with backoff, async actions |

Views are plain components selected by state; there is no router, which keeps the
mobile bundle small and avoids deep-linking rules that would need their own
authorisation checks.

## Scaling path

Everything stateful is either PostgreSQL or the workspace directory, so the
backend is horizontally scalable once workspaces move to shared storage. Moving
from the host command backend to the Docker backend is a configuration change
(`SANDBOX_ENABLED=true`), not a rewrite. Swapping OpenRouter for another provider
touches `services/llm.ts` alone.
