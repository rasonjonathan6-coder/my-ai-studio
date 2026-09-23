# OpenRouter setup

The agent's language model calls go to OpenRouter from the backend only. The key
never reaches the browser, an exported ZIP, a log line, or an Android APK.

## Getting a key

1. Create an account at <https://openrouter.ai>.
2. Open <https://openrouter.ai/keys> and create a key. It looks like
   `sk-or-v1-...`.
3. Copy it once. OpenRouter will not show the full value again.

Free-tier models exist but are rate limited; the default model id used here is
`openrouter/free`. Set `OPENROUTER_MODEL` to any model id that is available to
your account and supports tool calling.

## Configuring

Local development, in `backend/.env`:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-your-key-here
OPENROUTER_MODEL=openrouter/free
```

Production: set the same two variables as GitHub Actions secrets and as
environment variables on the host. Never write them into a tracked file.

Verify the backend sees the key without revealing it:

```bash
curl -s http://127.0.0.1:8080/api/health
```

The response states whether OpenRouter is configured. It never returns the key:

```json
{ "ok": true, "service": "my-ai-studio", "version": "1.0.0", "openrouter": "configured" }
```

When the key is absent the field reads `not_configured`, the agent reports the
same, and it performs only the read-only analysis it can do locally. It does not
fabricate a plan or claim a change it did not make.

## What the client handles

`services/openrouter.ts` implements:

| Condition | Behaviour |
| --- | --- |
| Request timeout | Aborts after the configured timeout, then retries with backoff |
| HTTP 429 | Honours `Retry-After`, retries a bounded number of times |
| HTTP 401/403 | Reports a configuration error; does not retry |
| HTTP 5xx | Retries with exponential backoff up to the attempt cap |
| Malformed JSON / unexpected shape | Reported as an invalid response, run fails cleanly |
| Model unavailable | Reported by name so the operator can change `OPENROUTER_MODEL` |

Every failure is logged with the status code and a short reason. Request headers
containing the key are never logged.

## Verifying a real call

With a key configured:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"model":"openrouter/free","messages":[{"role":"user","content":"reply with OK"}]}' \
  https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY"
```

If this fails the problem is the key, the model id, or account credit - not the
application.

## Free-tier daily quota

`openrouter/free` is capped per day, not per minute. Once the cap is hit the API
returns HTTP 429 with a body containing `free-models-per-day` and headers
`X-RateLimit-Limit: 50`, `X-RateLimit-Remaining: 0`, plus `X-RateLimit-Reset`
(a Unix epoch **milliseconds** value, typically the next midnight UTC).

The client distinguishes two 429 cases:

- transient throttle (no daily marker): retried with exponential backoff, or the
  provider's `Retry-After` if it sent one;
- exhausted daily quota (daily marker present): **not** retried inside the run.
  The run fails with `rate_limited: daily free-model quota exhausted; resets at
  <ISO timestamp>` so the reset time is visible instead of burning attempts.

To keep working past 50 requests/day, either add credits to the OpenRouter
account or point `OPENROUTER_MODEL` at another model. Raising
`OPENROUTER_MAX_RETRIES` will not help a daily quota.

## Testing the agent loop without spending quota

`scripts/scripted-model.mjs` is a small HTTP server that speaks the chat
completions response shape and replays a fixed tool sequence (read a file, edit
it, rebuild). Start it on a throwaway docker network and point a second backend
instance at it with `OPENROUTER_BASE_URL`. Only the model transport is stand-in
code: every tool it triggers - file edits, `./gradlew assembleDebug`, APK
inspection - runs for real. This is how the loop is verified when the daily
quota is exhausted.

## Keeping the key out of artifacts

Three independent controls enforce this:

1. The key is read only inside backend services, never serialised into a response.
2. The logger redacts known secret patterns before writing.
3. `build.yml` greps the built frontend bundle and `build-apk.yml` greps the APK
   archive and the Android sources for `sk-or-` and related patterns, failing the
   build if either finds one.
