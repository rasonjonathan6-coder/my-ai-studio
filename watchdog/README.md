# My AI Studio watchdog

An external supervisor that keeps the studio reachable.

It lives outside the studio on purpose. A supervisor running inside the runtime
it supervises cannot restart that runtime, because the thing that would perform
the restart is the thing that died. Nothing here imports studio code, and nothing
in the studio can reach this: the two only meet through the committed `url.json`
and the OpenHands API.

## What one cycle does

```
read url.json
      |
      v
probe {url}/api/health   (with retries)
      |
      +-- alive   -> do nothing at all
      +-- unknown -> do nothing, log, let the next cycle decide
      +-- dead    -> rebuild a runtime, verify it publicly, publish the new URL
```

`alive` and `unknown` both mean "change nothing". Only a conclusive failure
starts a rebuild.

## Why "dead" is hard to call

A sleeping laptop, a DNS hiccup and a restarting process all look like a failure
on a single probe. Rebuilding for any of them would churn sandboxes and publish a
new URL no better than the old one. So a failure only becomes a verdict when:

- several attempts spread over time have all failed, **and**
- at least one failed conclusively.

A 404 from a host that is up is conclusive: something is answering and it is not
the studio. A refused connection is not, because the host may be about to come
back. A health response from the studio that reports `ok: false` is also not
grounds for a rebuild - the process is up and reachable, and a fresh runtime
would not fix its internal problem.

## Running it

```bash
cd watchdog

# Detection only. Never creates a sandbox; safe to run on a schedule.
node src/watchdog.mjs --plan

# Full cycle. Rebuilds only when the studio is conclusively dead.
node src/watchdog.mjs

# Everything except writing url.json.
node src/watchdog.mjs --dry-run

npm test
```

Exit codes, for whatever schedules it:

| code | meaning |
|---|---|
| 0 | studio healthy, or nothing to do |
| 2 | a runtime was rebuilt and a new URL published |
| 1 | needs a human: rebuild refused, or recovery failed |

## Configuration

All optional; the defaults are what the tests exercise.

| variable | default | purpose |
|---|---|---|
| `URL_JSON_URL` | the committed `url.json` on `main` | where to read the current address |
| `WATCHDOG_HEALTH_ATTEMPTS` | `4` | probes before a failure is believed |
| `WATCHDOG_HEALTH_DELAY_MS` | `5000` | base delay between probes, backed off linearly |
| `WATCHDOG_HEALTH_TIMEOUT_MS` | `15000` | per-probe timeout |
| `WATCHDOG_MAX_REBUILDS_PER_DAY` | `4` | daily rebuild budget |
| `WATCHDOG_MIN_REBUILD_GAP_MS` | `600000` | minimum spacing between rebuilds |
| `WATCHDOG_STATE_PATH` | unset | where the loop guard keeps its history |
| `WATCHDOG_REPO_URL` | this repository | what to restore into a new runtime |
| `OPENHANDS_API_KEY` | required to rebuild | OpenHands credential |

## The loop guard

The failure this prevents is not one bad rebuild, it is an unattended watchdog
that rebuilds every time it runs. A studio that cannot start for a reason no
rebuild will fix - a GitHub outage, a missing configuration - would otherwise
consume the sandbox quota until nothing is left. The daily budget stops that and
makes the failure visible in the log instead.

## What a recovered runtime does and does not get

It gets the repository from GitHub, a fresh build, and a signing key generated
inside the sandbox. It does **not** inherit any credential from this process.

That is deliberate, and it is worth being precise about why. The sandbox secrets
API is read-only, so the only way to hand the runtime a real key would be the
command string itself, which is recorded in the sandbox's bash event history and
readable through the API afterwards. Copying a key in would leave it lying there.
A recovered runtime therefore starts with `DATABASE_URL` and `OPENROUTER_API_KEY`
unset, logs say so plainly, and those have to be configured on the new runtime.

## Verification

Recorded in `docs/WATCHDOG.md`: what was run, against what, and what came back.
Every API call this watchdog makes was exercised against the live service before
being written down, including creating a sandbox, running commands in it,
starting the studio on the exposed port, and reaching it over its public URL.
