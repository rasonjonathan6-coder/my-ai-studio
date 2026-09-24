# GitHub Actions

Four workflows under `.github/workflows/`. Each one runs real commands and fails
on real failures; none of them manufactures a passing result.

## test.yml - the correctness gate

Triggered on pull requests, on pushes to `main`, and manually.

| Job | What it does |
| --- | --- |
| `backend` | Starts a real `postgres:16-alpine` service, installs from the root lockfile, runs typecheck, lint, migrations, then asserts all ten core tables exist by querying `information_schema`. Runs the backend test suite, then boots the server and curls `/api/health` and `/api/system/status`. |
| (smoke) | Covered by `scripts/smoke.sh`, run locally and in the sandbox checks. |

Two details worth knowing:

- Dependencies are installed once at the repository root. This is an npm
  workspace, so `backend/` and `frontend/` have no lockfiles of their own; a
  `npm ci` inside those directories would fail.
- The table assertion queries the database rather than trusting the migration's
  exit code, so a migration that silently no-ops is caught.

## build.yml - build everything for real

| Job | What it does |
| --- | --- |
| `frontend` | Lint, unit tests, `vite build`, then greps the built bundle for `sk-or-`, `OPENROUTER_API_KEY`, `DATABASE_URL` and `JWT_SECRET`. A hit fails the job. Uploads `dist/` as an artifact. |
| `backend-image` | Builds the backend image from the repository root, starts a throwaway PostgreSQL, runs the container against it, and fails unless `/api/health` becomes ready. |
| `docs-check` | Asserts every documentation file listed in that step exists, and that no real `.env` file is tracked by git. |

The bundle scan is the reason the frontend can be trusted on a public CDN: it
proves at CI time that no secret was inlined by Vite.

## build-apk.yml - the Android pipeline

Triggered by changes under `android-samples/`, or manually with a `sample` input
(`all`, `hello`, `calculator`, `translator`).

Steps, in order:

1. Install Temurin JDK 17 and the Android SDK, then `sdkmanager --install
   "platform-tools" "platforms;android-34" "build-tools;34.0.0"` and accept
   licences. `sdkmanager --list_installed` prints what actually landed.
2. Cache Gradle, keyed on the sample build files.
3. For each selected sample, run `./gradlew test`.
4. For each selected sample, run `./gradlew assembleDebug`.
5. For each selected sample, run `./gradlew lintDebug`. Lint fails the build on
   errors. It is here because it catches API-level mistakes that compile cleanly
   and then crash on the device - it found `AccessibilityNodeInfo.hintText`
   (API 26+) in an app with `minSdk 24`.
6. **Verify the APK exists on disk.** If no file matches
   `*/build/outputs/apk/debug/*.apk`, the job prints `BUILD FAILED` and exits 1.
   The APK is never assumed from Gradle's exit code.
7. Inspect each APK with real tools: `aapt2 dump badging`, `dump permissions`,
   `dump xmltree --file AndroidManifest.xml`, and `apksigner verify --print-certs
   --verbose`. Reports are written to `apk-inspection/`.
8. Unzip each APK and grep its contents for key-shaped strings, then grep the
   project sources. Any hit is `SECURITY FAILED` and the job fails.
9. Package the APKs into `apk-artifact/` as `<sample>-app-debug.apk` together
   with `SHA256SUMS.txt` and `BUILD_INFO.txt` (commit, branch, build time, run
   number, Java, Gradle wrapper, Android Gradle Plugin, unit-test result, and
   each APK's name, size and SHA-256), grep that directory once more for
   key-shaped strings, then upload it as the `my-ai-studio-debug-apk` artifact
   with `if-no-files-found: error`. The inspection reports go up separately as
   `apk-inspection`.

`BUILD_INFO.txt` records `unit_tests: SUCCESS` only because the test step runs
under `set -e` and writes that output value as its final command: a failing
suite aborts the step and the job, so the file cannot claim a passing test run
that did not happen.

Each sample is a standalone Gradle project with its own wrapper; there is no
`android-samples/gradlew`, which is why the steps loop over samples instead of
invoking one shared wrapper.

## security.yml - audits and secret hygiene

| Job | What it does |
| --- | --- |
| `secret-scan` | Greps the working tree for committed keys and checks that no `.env` file is tracked. |
| `dependency-audit` | `npm audit --audit-level=high --omit=dev` for both workspaces. |
| `codeql` | GitHub's CodeQL analysis for `javascript-typescript`. |

## Required secrets and variables

Set these under **Settings -> Secrets and variables -> Actions**.

Secrets (never printed, never echoed into a file):

| Name | Used by | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | optional end-to-end job | lets CI exercise the agent against a real model |
| `DATABASE_URL` | optional end-to-end job | an external database instead of the service container |
| `JWT_SECRET` | optional | only if you add a job that boots a production-shaped server |

Variables (non-secret):

| Name | Purpose |
| --- | --- |
| `VITE_API_URL` | backend URL baked into the frontend build |

`test.yml`, `build.yml` and `build-apk.yml` are written to run with **no**
secrets: they use a throwaway PostgreSQL and CI-only placeholder values for
`JWT_SECRET`. The workflows that would genuinely need `OPENROUTER_API_KEY` are
the ones that exercise the agent end to end, and those are not enabled by
default so a fork PR cannot run up your model bill.

Never put a real secret in a workflow file, a repository variable or a
`VITE_*` variable. Only the Secrets store.

## Fork pull requests

`pull_request` does not expose secrets to forks, which is the correct default:
the workflows above need none. Do not "fix" this with `pull_request_target` and a
checkout of the fork's code - that combination runs untrusted code with write
permissions and access to your secrets.

## Running the Android workflow locally

The APK pipeline is the slowest and the most environment-sensitive, so verify
locally before pushing:

```bash
cd android-samples/calculator
./gradlew test
./gradlew assembleDebug
ls -l app/build/outputs/apk/debug/app-debug.apk
```

If that works locally but fails in CI, the difference is almost always the SDK
component list or the JDK version - check the `Show toolchain versions` and
`sdkmanager --list_installed` output in the failing job.

## Reading CI results from the app

The backend exposes the state of the latest workflow run so the Build Center can
show real CI status instead of a guess. Two routes, both behind the normal
session cookie:

| Route | Behaviour |
| --- | --- |
| `GET /api/system/github` | Probes the configured repository and reports the latest run with its artifacts |
| `GET /api/system/github/artifacts/:artifactId` | Streams one artifact archive through the server |

Configure with `GITHUB_REPO` (required) and `GITHUB_TOKEN` (optional, but needed
for private repositories and higher rate limits). With no repository the route
answers `NOT_CONFIGURED` and makes no outbound call.

The states are literal, not decorative:

| `state` | Meaning |
| --- | --- |
| `NOT_CONFIGURED` | `GITHUB_REPO` is unset; no request was made |
| `AVAILABLE` | GitHub answered; `latestRun` reflects a real run, or is `null` if the repository has none |
| `ERROR` | GitHub answered with an error (bad token, unknown repo, rate limit); `detail` carries the reason |

`AVAILABLE` means the call succeeded, not that a run is green: read
`latestRun.conclusion` for the outcome. The route never invents a run.

The status also carries `canWrite`. A repository probes green with a read-only
credential, so the state machine cannot tell "connected" from "can publish". The
server therefore creates a blob that nothing references - a real write, but one
that cannot touch a branch, a commit or the working tree, and that GitHub
garbage-collects. `canWrite: false` means the credential is authenticated but
unauthorized, and publishing or dispatching will be refused; `null` means the
probe was inconclusive (no credential, or a network failure).

### The credential needs write permissions, not just read

A token that can read the repository is not enough. Publishing writes blobs and
updates a ref, and dispatching calls `POST .../dispatches`; a read-only
credential answers `200` to every `GET` and then `403 Resource not accessible by
integration` to the first write. When that happens the error now says so
directly and names the fix, rather than passing GitHub's message through
unexplained.

For a fine-grained personal access token on `owner/repo`:

| Permission | Level | Needed for |
| --- | --- | --- |
| Contents | Read and write | publishing the workspace (blobs, tree, commit, ref) |
| Actions | Read and write | dispatching the workflow, cancelling a run |

Metadata: Read is granted automatically and is not settable.

A GitHub App used instead of a token needs the same two permissions, plus
`Metadata: Read`. `canWrite` is probed for both credential shapes.

Server-side only: the token is read from the environment, attached to outbound
requests, and redacted from logs and error strings. It is never placed in an API
response, a WebSocket frame, an exported ZIP or a log line. `GET /api/system/github`
reports `tokenConfigured: true` and the credential kind (`token` or `app`),
never the value.

## Publishing the workspace and dispatching the build

| Route | Behaviour |
| --- | --- |
| `POST /api/projects/:id/github/sync` | Publishes the workspace to the configured repository |
| `POST /api/projects/:id/github/build` | Publishes, then dispatches the workflow and records the run |

Publishing uses the Git Data API, not the contents API, so a whole project lands
in one commit:

1. read the branch head, and the head commit's tree;
2. create one blob per file;
3. create a tree over that commit's tree as `base_tree`, so files not in the
   workspace are preserved rather than deleted by a sparse publish;
4. create a commit whose parent is the head, then move the branch to it.

The managed workflow (`.github/workflows/android-build.yml`) is written into the
same commit, so the repository always holds the workflow that the server
dispatches. Build output (`.gradle/`, `app/build/`, `node_modules/`, `.git/`,
APKs) is skipped, and the skip list is reported back in `skipped`.

A refused write stops the sequence before the commit is created: no branch is
moved, and the route reports `blob creation failed: 403 ...` rather than
claiming a publish. When publishing fails, `POST .../github/build` answers with
that reason and dispatches nothing - it does not start a run against a stale
tree.

## Verification status of the live path

The publishing and dispatching code paths are covered by tests against a local
HTTP server (`backend/tests/githubBuilds.test.ts`) that assert the exact request
sequence, the `base_tree` argument, the default-branch install, and that a
refused write aborts before any commit:

- CASE 3 - the publish sequence and the managed-workflow install.
- CASE 3c - an already-current default branch is left untouched.
- CASE 3b - a refused write stops the publish before any commit.
- CASE 16 - a run-log archive is unpacked into real text; non-archives refused.

The live path has since been verified end to end against
`rasonjonathan6-coder/app` with a fine-grained PAT held only in the server
environment. The token permissions required are: **Contents** read/write,
**Actions** read/write, **Workflows** read/write, **Metadata** read-only.

Results, all through My AI Studio's own routes:

| Step | Route | Result |
| --- | --- | --- |
| capability probe | `GET /api/system/github` | `state AVAILABLE`, `canWrite true` |
| publish | `POST /api/projects/:id/github/sync` | HTTP 200, 15 files, `workflowOnDefaultBranch: main` |
| dispatch | `POST /api/projects/:id/github/build` | HTTP 202, `status: queued`, run `36030411740` |
| run outcome | `GET …/github/build/:buildId` | `success` / `success` |
| APK download | `GET …/github/build/:buildId/apk` | HTTP 200, 3 189 843 bytes, valid ZIP with `AndroidManifest.xml`, 422 entries |
| logs | `GET …/github/build/:buildId/logs` | 81 397 characters of real job text containing `BUILD SUCCESSFUL` |

A `workflow_dispatch` workflow is only registered by GitHub when it exists on the
repository's **default** branch. Publishing to the build branch alone left
`GET /actions/workflows` at `0`, so dispatch answered `404`. A publish therefore
also installs the managed workflow on the default branch, and skips the write
when the same blob is already there, so a project's default branch is not
rewritten on every sync.

**GITHUB PUBLISH / DISPATCH E2E: PASS.**

The browser never receives `GITHUB_TOKEN`. The artifact route validates that the
requested id belongs to the latest run of the configured repository before
downloading, then attaches the token server-side; an id from another repository
is rejected with `404`, and a token-less server cannot download action artifacts
at all (GitHub requires authentication), which the route reports as `503` rather
than fetching anonymously.
