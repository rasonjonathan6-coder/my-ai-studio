-- Server-side GitHub credential owned by My AI Studio itself.
--
-- The runtime this app is developed in injects a GITHUB_TOKEN into every
-- process, and a process environment variable always beats --env-file, so a
-- deployment can never win that name. This table gives the app its own durable
-- credential that is independent of anything the host injects, and survives a
-- restart because it lives in the database rather than in a process environment.
--
-- The token is stored encrypted (AES-256-GCM, key derived from JWT_SECRET), so
-- a database dump alone does not disclose it. `fingerprint` is a short
-- non-reversible digest shown in the admin UI so an operator can tell two
-- credentials apart without the value ever leaving the server.

CREATE TABLE IF NOT EXISTS github_credentials (
  id           TEXT PRIMARY KEY DEFAULT 'default',
  ciphertext   TEXT NOT NULL,
  iv           TEXT NOT NULL,
  auth_tag     TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  token_kind   TEXT NOT NULL,
  repo         TEXT,
  updated_by   UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT github_credentials_singleton CHECK (id = 'default')
);

-- Admin flag. There is no role system yet, so a boolean is enough; the first
-- registered user is promoted to admin so a fresh deployment can be configured.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_admin_idx ON users (is_admin) WHERE is_admin;
