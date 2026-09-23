-- Records which AI provider actually served an agent run and whether AUTO had
-- to fail over to it. `model` already exists and holds the model that answered.
-- Kept nullable so historical runs remain valid.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS failover_from TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS failover_reason TEXT;

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_provider_valid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_provider_valid
  CHECK (provider IS NULL OR provider IN ('openrouter', 'gemini', 'groq'));
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_failover_from_valid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_failover_from_valid
  CHECK (failover_from IS NULL OR failover_from IN ('openrouter', 'gemini', 'groq'));

CREATE INDEX IF NOT EXISTS agent_runs_provider_idx ON agent_runs (provider, created_at DESC);
