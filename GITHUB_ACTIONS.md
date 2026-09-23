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
5. **Verify the APK exists on disk.** If no file matches
   `*/build/outputs/apk/debug/*.apk`, the job prints `BUILD FAILED` and exits 1.
   The APK is never assumed from Gradle's exit code.
6. Inspect each APK with real tools: `aapt2 dump badging`, `dump permissions`,
   `dump xmltree --file AndroidManifest.xml`, and `apksigner verify --print-certs
   --verbose`. Reports are written to `apk-inspection/`.
7. Unzip each APK and grep its contents for key-shaped strings, then grep the
   project sources. Any hit is `SECURITY FAILED` and the job fails.
8. Upload the APKs and the inspection reports as artifacts with
   `if-no-files-found: error`, so a missing artifact fails rather than uploading
   an empty set.

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
