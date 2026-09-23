# Testing the agent loop for real

The agent loop is the part of My AI Studio most likely to be quietly faked: a
plausible-looking transcript is easy to produce and proves nothing. This document
describes how the loop is actually verified in this repository, including when
the real model is unavailable.

## What counts as proof

A loop run is only evidence if all of the following hold:

1. the run is started through the HTTP API and reaches a terminal status;
2. the source file that was broken has visibly changed on disk afterwards;
3. the build that ran produced an APK whose SHA256 matches what the API reports;
4. the tool sequence recorded during the run matches the transcript.

Anything less is a demonstration, not a verification.

## Two ways to drive the loop

### With the real model

Set `OPENROUTER_API_KEY` and run the agent through `POST /api/projects/:id/agent/run`.
This exercises the real transport, prompt and model. It is limited by the
OpenRouter free-tier daily quota (see `OPENROUTER_SETUP.md`).

### With the scripted model

`scripts/scripted-model.mjs` implements the chat-completions response shape and
replays a fixed tool sequence. It replaces **only the model transport**. Every
tool the sequence triggers - `read_file`, `edit_file`, `build_android` - executes
through the normal backend code paths against the real workspace, and the loop's
own VERIFY phase runs the real Gradle build regardless of what the scripted model
claims.

Run it on an isolated docker network so the development stack is untouched:

```bash
# Host, one network and one scripted model container
sudo -n docker network create mas-loop-test
PROJECT_ID=<project-uuid>
sudo -n docker run -d --name mas-scripted --network mas-loop-test \
  -e PORT=9099 -e PROJECT_DIR=/project \
  -v "/data/workspaces/$PROJECT_ID:/project" \
  -v "$PWD/scripts/scripted-model.mjs:/app/model.mjs:ro" \
  node:24-alpine node /app/model.mjs

# A second backend instance pointed at it, sharing the existing database.
# Attach the running postgres to the test network first.
sudo -n docker network connect mas-loop-test mas-pg
sudo -n docker run -d --name mas-api-test --network mas-loop-test -p 8081:8080 \
  --link mas-scripted:s-model \
  --group-add "$(stat -c '%g' /var/run/docker.sock)" \
  -e NODE_ENV=production -e JWT_SECRET=<same-secret-as-main-stack> \
  -e DATABASE_URL=postgres://studio:studiopw@mas-pg:5432/myaistudio \
  -e WORKSPACE_PATH=/data/workspaces -e STORAGE_PATH=/data/storage \
  -e SANDBOX_ENABLED=true -e SANDBOX_IMAGE=my-ai-studio-sandbox:latest \
  -e SANDBOX_EXTRA_MOUNTS=/opt/android-sdk:/opt/android-sdk:ro,/opt/gradle-cache:/opt/gradle-cache \
  -e ANDROID_HOME=/opt/android-sdk -e GRADLE_USER_HOME=/opt/gradle-cache \
  -e OPENROUTER_API_KEY=scripted-local-key \
  -e OPENROUTER_BASE_URL=http://mas-scripted:9099 \
  -e OPENROUTER_MODEL=local/scripted \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /data/workspaces:/data/workspaces -v /data/storage:/data/storage \
  -v /opt/android-sdk:/opt/android-sdk:ro \
  my-ai-studio-backend:jdk
```

Then break a source file, launch a run against port 8081, and confirm the four
proof points above.

## Reading the tool sequence

The scripted model appends every request it receives to
`.scripted-model-calls.log` inside the project workspace. Each line carries the
tool result the loop fed back, so the transcript can be checked against what
actually happened:

```
{"step":1,"lastUser":"Tool \"read_file\" result (ok=true): ..."}
{"step":2,"lastUser":"Tool \"edit_file\" result (ok=true): ..."}
{"step":3,"lastUser":"Tool \"build_android\" result (ok=true): {\"status\":\"succeeded\", ...}"}
```

Delete this file after a test run; it is a diagnostic artifact, not part of the
project.

## Failure injection

The most valuable loop assertion is that a **broken** build is not reported as
success. To check it without any model at all:

1. introduce a real compile error in a Kotlin source file;
2. call `POST /api/projects/:id/build` with `{"kind":"android-debug"}`;
3. expect `status: "failed"` and `apk: null`, and confirm the backend log contains
   no `apk produced` line for that build.

This catches the specific regression where a failed build re-attached the APK
left over from an earlier successful build.

## Cleanup

```bash
sudo -n docker rm -f mas-scripted mas-api-test
sudo -n docker network disconnect mas-loop-test mas-pg
sudo -n docker network rm mas-loop-test
```

The development stack on port 8080 and `mas-pg` keep running unchanged.
