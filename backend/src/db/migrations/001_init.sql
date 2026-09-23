-- My AI Studio initial schema.
-- Applied by backend/src/db/migrate.ts inside a per-file transaction.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  template        TEXT NOT NULL DEFAULT 'blank',
  kind            TEXT NOT NULL DEFAULT 'generic',
  package_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT projects_kind_valid CHECK (kind IN ('generic', 'android', 'node', 'static')),
  CONSTRAINT projects_name_len CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT projects_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_owner_slug_key ON projects (owner_id, slug);
CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT 'New conversation',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations (project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT messages_role_valid CHECK (role IN ('user', 'assistant', 'system', 'tool'))
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  conversation_id   UUID REFERENCES conversations (id) ON DELETE SET NULL,
  owner_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  prompt            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  phase             TEXT NOT NULL DEFAULT 'queued',
  model             TEXT,
  fix_attempts      INTEGER NOT NULL DEFAULT 0,
  max_fix_attempts  INTEGER NOT NULL DEFAULT 5,
  summary           TEXT,
  error             TEXT,
  tokens_in         INTEGER NOT NULL DEFAULT 0,
  tokens_out        INTEGER NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_runs_status_valid CHECK (status IN ('queued','running','succeeded','failed','cancelled','limit_reached')),
  CONSTRAINT agent_runs_phase_valid CHECK (phase IN ('queued','analyzing','planning','reading','editing','running','testing','building','inspecting','fixing','completed','failed'))
);
CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON agent_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_active_idx ON agent_runs (status) WHERE status IN ('queued','running');

CREATE TABLE IF NOT EXISTS commands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_run_id  UUID REFERENCES agent_runs (id) ON DELETE SET NULL,
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source        TEXT NOT NULL DEFAULT 'terminal',
  command       TEXT NOT NULL,
  cwd           TEXT,
  stdout        TEXT NOT NULL DEFAULT '',
  stderr        TEXT NOT NULL DEFAULT '',
  exit_code     INTEGER,
  duration_ms   INTEGER,
  truncated     BOOLEAN NOT NULL DEFAULT false,
  timed_out     BOOLEAN NOT NULL DEFAULT false,
  status        TEXT NOT NULL DEFAULT 'running',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commands_source_valid CHECK (source IN ('terminal','agent','build','test')),
  CONSTRAINT commands_status_valid CHECK (status IN ('running','succeeded','failed','timeout'))
);
CREATE INDEX IF NOT EXISTS commands_project_idx ON commands (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS builds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_run_id    UUID REFERENCES agent_runs (id) ON DELETE SET NULL,
  owner_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL DEFAULT 'generic',
  target          TEXT NOT NULL DEFAULT 'debug',
  status          TEXT NOT NULL DEFAULT 'running',
  command         TEXT,
  log             TEXT NOT NULL DEFAULT '',
  exit_code       INTEGER,
  duration_ms     INTEGER,
  apk_path        TEXT,
  apk_size_bytes  BIGINT,
  apk_sha256      TEXT,
  inspection      JSONB,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  CONSTRAINT builds_kind_valid CHECK (kind IN ('generic','android','node')),
  CONSTRAINT builds_status_valid CHECK (status IN ('running','succeeded','failed','timeout'))
);
CREATE INDEX IF NOT EXISTS builds_project_idx ON builds (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  agent_run_id  UUID REFERENCES agent_runs (id) ON DELETE SET NULL,
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  framework     TEXT NOT NULL DEFAULT 'unknown',
  command       TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  passed        INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  log           TEXT NOT NULL DEFAULT '',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  CONSTRAINT tests_status_valid CHECK (status IN ('running','passed','failed','timeout','unavailable'))
);
CREATE INDEX IF NOT EXISTS tests_project_idx ON tests (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  build_id      UUID REFERENCES builds (id) ON DELETE SET NULL,
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL DEFAULT 0,
  sha256        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artifacts_kind_valid CHECK (kind IN ('apk','zip','log','report','other'))
);
CREATE INDEX IF NOT EXISTS artifacts_project_idx ON artifacts (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS deployments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  environment   TEXT NOT NULL DEFAULT 'preview',
  status        TEXT NOT NULL DEFAULT 'not_started',
  url           TEXT,
  log           TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT deployments_status_valid CHECK (status IN ('not_started','running','succeeded','failed','unavailable'))
);
CREATE INDEX IF NOT EXISTS deployments_project_idx ON deployments (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  project_id  UUID REFERENCES projects (id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  outcome     TEXT NOT NULL DEFAULT 'ok',
  ip          TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_project_idx ON audit_logs (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS security_scans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  build_id      UUID REFERENCES builds (id) ON DELETE SET NULL,
  owner_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status        TEXT NOT NULL,
  findings      JSONB NOT NULL DEFAULT '[]'::jsonb,
  files_scanned INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT security_scans_status_valid CHECK (status IN ('clean','findings','error'))
);
CREATE INDEX IF NOT EXISTS security_scans_project_idx ON security_scans (project_id, created_at DESC);
