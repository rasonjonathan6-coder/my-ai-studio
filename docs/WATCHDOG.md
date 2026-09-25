# Watchdog verification record

What was actually run, against what, and what came back. Nothing here is
projected or assumed; where something could not be tested it says so.

Date: 2026-09-25. Node `v24.21.0`.

## Test suite

```
cd watchdog && npm test
```

```
ℹ tests 162
ℹ suites 33
ℹ pass 162
ℹ fail 0
```

The suite covers the decision logic, the loop guard, secret redaction, the
recovery steps, and the publish itself. The OpenHands API and the sandbox are
faked in the suite, because a test cannot wait for a real sandbox to fail a
build; those paths are covered by the live runs below instead.

The publish tests are the exception, and deliberately not faked: they build a
real git repository with a real bare remote in a temp directory and run the real
`makePublisher`, so the commit and the push genuinely happen and the assertions
read what git recorded. `tests/publish.test.mjs` covers the write, the commit
scoped to `url.json`, the refusal when a foreign file is staged (and the rollback
that undoes it), a rejected push failing the publish, dry-run touching nothing,
and no credential reaching `url.json` or the log. `tests/cli.test.mjs` runs the
whole cycle through the real command line twice: once succeeding, to check that
`url.json` really changed on the remote, and once with no remote, to check that a
push that cannot land exits non-zero and discards the sandbox.

### Publishing wiring

The publish step is now real rather than `--dry-run`, and the workflow carries
`contents: write` for it. Both are pinned by `tests/ci-triggers.test.mjs`,
together with the two failure modes they invite: an unused `--dry-run` (which
would report success while publishing nothing) and an unconditional `exit 0`
(which would report a failed recovery as green). Sabotaging either one, or
downgrading the permission, fails the suite.

The commit is narrowed to `url.json` by the publisher itself, and a committer
identity is set locally only when the checkout did not supply one. Verified by
running the real publisher against a repository with a real remote.

Two things about this path are **not tested**: the push has not been exercised
against GitHub itself (only against a local bare remote, which fails and succeeds
for the same reasons but over a different transport), and the workflow has not
been dispatched with `mode=rebuild`, because that spends quota and creates a
sandbox.

## Live runs

Each of these was executed against real services. The fake sandbox in the suite
is not what these results rest on.

### 1. Studio healthy - no action

Against the live committed `url.json`.

```
node src/watchdog.mjs --plan
```

```
studio address read        url=https://work-1-mhfmdgfvdofypukx.prod-runtime.all-hands.dev
studio is alive; nothing to do
                           detail="service=my-ai-studio version=1.0.0"
```

Exit 0. No sandbox created.

### 2. Unreachable host - not conclusive

`url.json` repointed at a hostname with no DNS record, served over a local
document server so the real GitHub copy was untouched.

```
WATCHDOG_HEALTH_ATTEMPTS=3 node src/watchdog.mjs --plan
```

```
studio did not answer conclusively; leaving it alone
                           detail="no conclusive answer after 3 attempts
                                   (last: unreachable: fetch failed)"
```

Exit 0. Three attempts, **no rebuild**. This is the case that must not rebuild:
it is indistinguishable from a sleeping laptop or a DNS blip.

### 3. Host up but not the studio - conclusive

`url.json` repointed at a local server that answers 404 to everything.

```
node src/watchdog.mjs --plan
```

```
studio is dead            detail="health returned HTTP 404 at .../api/health"
plan-only: would rebuild now, but no sandbox was created
```

Exit 0, one attempt, no retry. A 404 is conclusive, so retrying would only waste
time.

### 4. Full recovery, end to end

`url.json` repointed at the 404 host, then a real cycle in `--dry-run` so
`url.json` would not be written.

```
URL_JSON_URL=<local> node src/watchdog.mjs --dry-run
```

| step | result | ms |
|---|---|---|
| validate credential | ok | 157 |
| create sandbox | ok | 5648 |
| restore repository | ok, `Cloning into 'project'...` | 1098 |
| install dependencies and build | ok | 10168 |
| start studio | ok | 10039 |
| confirm studio is serving locally | ok | 38 |
| confirm studio is reachable publicly | ok, `service=my-ai-studio version=1.0.0` | 41 |
| publish new URL | dry-run, not written | 0 |

```
cycle finished   action=rebuilt
                 url=https://work-1-hcklzvmtppaelqnq.prod-runtime.all-hands.dev
                 ms=27418
```

The recovered runtime's own log, read back from the sandbox:

```
my-ai-studio backend listening   url=http://0.0.0.0:12000  env=production
                                 database=not_configured
                                 openrouter=not_configured
                                 executionBackend=host
```

Note `database=not_configured` and `openrouter=not_configured`. These runs were recorded
before the watchdog could hand a recovered runtime its configuration, so the runtime was
genuinely degraded and the log said so rather than implying it was fully configured.

That changed: the configuration is now written into the sandbox as `/tmp/studio.env`
over multipart and read back at launch with `node --env-file`, so a `not_configured`
line now means the corresponding repository secret is unset. See the README's runtime
configuration section for the names.

After the run, `url.json` was confirmed unchanged, and the sandbox the dry run
created (`IHBNOL94O0ceFTKxD6FT2`) was deleted; a follow-up listing showed only
the studio's own sandbox remaining.

### 5. Publishing refuses an unverified URL

Run against an isolated copy of the repository, so the real `url.json` was never
at risk.

```
node scripts/url-json-update.mjs --url https://dead-host-9f8e7d.example
```

```
FAILED: https://dead-host-9f8e7d.example is not serving My AI Studio - fetch failed
```

Exit 1, and the copy's `url.json` was left exactly as it was. Then:

```
node scripts/url-json-update.mjs --url https://work-1-mhfmdgfvdofypukx.prod-runtime.all-hands.dev
```

```
verified: ... (service=my-ai-studio version=1.0.0)
url changed: https://old-host.example -> https://work-1-mhfmdgfvdofypukx...
```

Exit 0, with `previousUrl` set to the value it replaced.

### 6. Loop guard

With four rebuilds already recorded in the state file and a budget of four:

```
action=blocked   reason="daily rebuild budget exhausted (4/4 in 24h)"
```

No sandbox created. Covered by unit tests as well, including the minimum-gap case
and the 24-hour window.

## Bugs found by these runs, and fixed

Recorded because each one produced a wrong result that the unit tests alone did
not catch.

1. **The start command never started the server.** The steps were joined with
   spaces instead of `&&`, so `cd /workspace/project rm -f ...` became one `cd`
   with two arguments, which fails. The launch silently did nothing and the local
   health check read `000`. Found by live run 4.

2. **`env` swallowed the separators.** With the `&&` fix, the environment
   assignments were separate array entries, which put the separators inside the
   `env` invocation. The env assignments are now a single joined argument.

3. **The public health check inverted its own result.** The probe returns
   `{verdict}`, but the recovery read `{ok}`. Live run 4 printed
   `public health failed: service=my-ai-studio version=1.0.0` - a success read as
   a failure. The recovery now accepts either shape, and both come from the same
   code path so "alive" means one thing.

4. **The log could not name the URL it checked.** The studio URL was in the
   redaction list, because it arrives in an environment variable and looked like
   a credential. It is public by design - it is what `url.json` publishes - and
   redacting it made every log line useless. Removed, with a regression test.

5. **The local health check sampled once.** A server that took a moment to bind
   the port was reported as failed. It now polls for up to 30 seconds.

## Not tested

- **Scheduled execution.** Both workflows ship inert, with `workflow_dispatch`
  only. The schedule block in `watchdog.yml` is commented out; enabling it lets
  the job create sandboxes unattended, which is an operational decision. The
  cycle itself is verified, but its behaviour on a cron has not been observed.

- **A rebuild triggered by a real studio outage.** Every recovery run here used a
  deliberately dead URL to trigger it. The studio has not actually died, so
  recovery from a genuine outage has not been observed.

- **Recovery of a runtime with a database and a provider key configured.** The recovered
  runtime was verified running without them, and the mechanism that supplies them is
  covered by the suite. What has not been observed is a live recovery with the secrets
  set: no `mode=rebuild` dispatch has been run since the mechanism landed, and doing so
  spends a sandbox. Until that run exists, treat "a recovered runtime connects to the
  database" as NOT TESTED against the live service.

- **Publishing over GitHub's own transport.** The commit and the push are
  exercised against a real local bare remote, which is where the logic lives - the
  scoping to `url.json`, the refusal, the rollback, the failure on a rejected
  push. What has not been exercised is the push against GitHub with the checkout's
  credential, or `contents: write` on the runner. Those need a `mode=rebuild`
  dispatch, which creates a sandbox and spends quota.

- **The live runs above were recorded with `--dry-run`.** They describe the
  recovery before the publish step was wired to commit and push, so the "publish
  new URL" row in each reads "dry-run, not written". The wiring itself is covered
  by the suite, not by those runs.
