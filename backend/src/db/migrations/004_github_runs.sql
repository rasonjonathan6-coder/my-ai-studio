-- GitHub Actions builds triggered from My AI Studio.
--
-- One row per dispatched workflow run. `status` is our own normalised state and
-- is only ever set to 'success' after the remote run reported conclusion
-- success AND an APK artifact was fetched and validated, so a row can never
-- claim a success that GitHub did not produce.
CREATE TABLE IF NOT EXISTS github_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  owner_id          UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  build_id          UUID REFERENCES builds (id) ON DELETE SET NULL,
  repo              TEXT NOT NULL,
  workflow          TEXT NOT NULL,
  ref               TEXT NOT NULL,
  run_id            BIGINT,
  run_number        INTEGER,
  html_url          TEXT,
  status            TEXT NOT NULL DEFAULT 'queued',
  conclusion        TEXT,
  apk_name          TEXT,
  apk_size_bytes    BIGINT,
  apk_sha256        TEXT,
  apk_artifact_id   BIGINT,
  apk_package       TEXT,
  apk_version_name  TEXT,
  apk_version_code  TEXT,
  apk_valid         BOOLEAN NOT NULL DEFAULT false,
  log               TEXT NOT NULL DEFAULT '',
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT github_runs_status_valid CHECK (
    status IN ('queued','running','testing','building','success','failed','cancelled','timeout','not_configured','blocked')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS github_runs_run_id_key ON github_runs (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS github_runs_project_idx ON github_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS github_runs_owner_idx ON github_runs (owner_id, created_at DESC);
