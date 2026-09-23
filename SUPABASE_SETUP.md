# Supabase PostgreSQL setup

Supabase provides the managed PostgreSQL this app uses in production. Nothing in
the codebase is Supabase-specific: the backend speaks plain PostgreSQL over
`DATABASE_URL`, so you can swap in any managed provider (Neon, RDS, a local
server) without touching code.

## 1. Create the project

1. Sign in at <https://supabase.com> and create a new project.
2. Choose a region close to your backend VM. Oracle Cloud Always Free regions and
   Supabase regions are not the same set, so pick the nearest pair.
3. Save the database password when prompted. It is shown once.

## 2. Get the connection string

In the dashboard: **Project Settings -> Database -> Connection string**.

Two variants are offered:

| Variant | Port | Use |
| --- | --- | --- |
| Direct connection | 5432 | Migrations and long-lived poolers |
| Connection pooler (Supavisor, session mode) | 6543 | Short-lived serverless clients |

This backend keeps a persistent pool, so use the **direct** connection or the
pooler in **session** mode. Transaction mode (`6543`, transaction) breaks
prepared statements and is not suitable for this pool configuration.

The string looks like:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Append `?sslmode=require`. Supabase rejects unencrypted connections.

Set it in `.env` on the server:

```bash
DATABASE_URL=postgresql://...your-string...?sslmode=require
DATABASE_SSL=true
```

**Never commit this value.** `.env` is gitignored, and the repository ships only
`.env.example` / `.env.production.example` with empty placeholders. Do not paste
the password into an issue, a PR, a README or a chat: anyone with it has full
access to the database.

## 3. Run the migrations

```bash
npm run migrate
```

This applies every file in `backend/src/db/migrations/` in order and records it
in `schema_migrations`, so re-running is safe. It creates thirteen tables:

```
users, projects, conversations, messages, agent_runs, commands, builds,
tests, artifacts, deployments, audit_logs, security_scans, schema_migrations
```

Confirm from the SQL editor:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by 1;
```

## 4. Verify the connection

```bash
curl -s http://127.0.0.1:8080/api/system/status
```

The `postgres` component should read `available`. If it reads `error`, the
backend log line names the failure - usually a wrong password, a missing
`sslmode=require`, or the machine's IP not being reachable.

`/api/health/ready` is the readiness probe: it returns 503 until the database
answers **and** OpenRouter is configured, and names which check is failing. If you
run without an OpenRouter key, use `/api/health` (always 200) for liveness and
ignore the readiness endpoint.

## 5. Networking

Supabase does not expose the database to the whole internet by default, but if
you restrict access, add your VM's egress IP to the allowed list under
**Project Settings -> Database -> Network restrictions**. A backend that cannot
reach the database fails at startup with a clear error rather than serving
degraded responses.

## 6. Backups

Supabase takes automatic daily backups on paid plans; the free tier is thinner.
Do not treat provider backups as your only copy. `DEPLOYMENT.md` has a
`pg_dump` recipe you can run on a schedule against the same `DATABASE_URL`, and
it works unchanged against Supabase.

## 7. Security notes

- The frontend never talks to the database. It calls the backend API, which
  holds the only connection and the only credentials.
- Row Level Security is not used. All access control is enforced in the backend
  by `project_id` ownership checks on every query, because the API is the only
  client and it connects as the table owner. If you later expose Supabase's
  auto-generated REST API, enable RLS on every table first - by default that API
  would be reachable with the anon key.
- Rotate the database password in the dashboard and update `DATABASE_URL` if it
  is ever exposed.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `no pg_hba.conf entry` | `sslmode=require` missing from the URL |
| `password authentication failed` | password contains URL-reserved characters; percent-encode them |
| `getaddrinfo ENOTFOUND` | wrong project ref or region in the hostname |
| `too many connections` | pool too large; lower `DATABASE_POOL_MAX` or use the pooler |
| `prepared statement already exists` | you are on the transaction-mode pooler; switch to direct or session mode |
