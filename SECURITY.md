# Security

## Threat model

The platform runs untrusted, model-generated code and untrusted shell commands
on behalf of users. The realistic threats, in priority order:

1. **A user reaching another user's data or workspace.** Mitigated by ownership
   checks on every route and WebSocket subscription, plus workspace paths derived
   only from the project UUID.
2. **Command injection / arbitrary execution escaping the workspace.** Mitigated
   by workspace-confined working directories, path resolution that rejects any
   escape, and a command denylist on the host backend.
3. **Secret leakage** into the browser, logs, exports or an APK. Mitigated by
   server-side-only secrets, log redaction, export exclusions and secret scans.
4. **Resource exhaustion** from a runaway generated command. Mitigated by
   timeouts, output caps, file-size caps and a concurrent-job limit.

## Controls in place

### Authentication and sessions

- Passwords hashed with bcrypt (cost factor 12). Plaintext is never stored or
  logged.
- Sessions are opaque random tokens stored hashed in the `sessions` table and
  delivered in an `httpOnly`, `SameSite=Lax` cookie. Nothing is kept in
  `localStorage`, so XSS cannot read the session.
- `Secure` is set when `NODE_ENV=production`.

### Authorisation

- Every `/api/projects/:id/*` route loads the project and compares its owner to
  the session user before doing anything else. A mismatch returns 404 rather than
  403, so project existence is not disclosed.
- The WebSocket server authenticates the session cookie and authorises the
  project on subscribe, closing with 4401 (unauthenticated) or 4403 (forbidden).
- The smoke test asserts both cross-user and unauthenticated access are denied.

### Filesystem confinement

`lib/paths.ts` resolves every requested path against the project root and then
verifies the resolved absolute path still lies inside that root. Because the
check runs on the resolved path, `..` sequences and absolute paths both fail.
Symlinks are resolved before the check, so they cannot be used to escape either.
`resolveInsideExisting` additionally refuses to create anything outside the root.

Rejections surface as a `PathSecurityError`, which the smoke test triggers
deliberately with a `../` payload and asserts is refused.

### Command execution

- Commands run with the project workspace as the working directory.
- An environment allowlist strips secrets before the child process starts.
- A denylist rejects destructive patterns on the host backend.
- Every command has a wall-clock timeout and an output byte cap; excess output is
  truncated and the truncation is reported.
- With `SANDBOX_ENABLED=true` commands run in an ephemeral Docker container as a
  non-root user with CPU, memory, PID and disk limits and no access to the Docker
  socket or host environment.

The backend always reports which execution backend was used, so the UI never
claims sandboxing that is not active.

### Secrets

- `OPENROUTER_API_KEY`, `DATABASE_URL` and `JWT_SECRET` are read from the server
  environment only.
- The logger redacts values matching known secret patterns and the current
  process environment secrets before writing.
- `services/securityScan.ts` scans project sources and the APK archive for
  `OPENROUTER_API_KEY`, `sk-or-`, `openrouter.ai`, `password=`, `secret=`,
  `api_key=`, `apikey=`, `token=`, `private_key`. Findings carry a short redacted
  preview, never the full value.
- The ZIP export excludes `.env`/`.env.*`, key material, `node_modules`, `.git`
  and build outputs.
- `GET /api/health` reports only whether OpenRouter is configured, never the key.
- No `VITE_*` variable may hold a secret; the frontend build workflow greps the
  built bundle for secret patterns and fails if any appear.

### Input validation

Request bodies and query parameters are validated with `zod` schemas in
`middleware/validate.ts`. Types, ranges and lengths are checked before a handler
runs. Project ids must be UUIDs. File paths and search queries are length-capped.

### Rate limiting

Sliding-window limits are applied per client for general API traffic, and
tighter limits for authentication and job-starting endpoints. Exceeding a limit
returns 429 with a `Retry-After` header.

### Headers

`helmet` supplies `Content-Security-Policy`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options` and HSTS in production. CORS is restricted
to the configured frontend origin with credentials enabled.

### Audit logging

Authentication events, project creation/deletion, and every command, build and
agent run are recorded in `audit_logs` with actor, action, target and timestamp.
Logs never contain secret values.

## Residual risks and honest limitations

- **The host execution backend is not a sandbox.** It confines paths and strips
  secrets but shares the host kernel and filesystem. Only the Docker backend
  provides isolation, and it is `NOT AVAILABLE` unless a daemon is present. Treat
  host-mode deployments as single-tenant or trusted-user only.
- **Model-generated code is untrusted by definition.** Even sandboxed, it may
  attempt prompt injection against the agent. Tool outputs are treated as data
  and never as instructions.
- **Android accessibility APIs are not universally usable.** Some applications
  deliberately block them, so the translator sample cannot be guaranteed to work
  everywhere. The UI says so rather than implying otherwise.
- **No penetration test has been performed.** Controls above are tested by the
  smoke script and the CI security workflow, which is not the same as an
  independent audit.

## Reporting a vulnerability

Report privately to the maintainer rather than opening a public issue. Include
reproduction steps and the affected endpoint. Do not include real credentials.
