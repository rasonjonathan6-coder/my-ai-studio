-- 002 pinned the recorded provider to the three providers that existed then.
-- The router now serves twelve, so a run served by any of the newer ones (or
-- one refused by FREE_ONLY before any request) failed the old CHECK and the
-- terminal status could not be written. Widen both columns to the full set.
-- Kept as a value list rather than a FK so a row survives a provider being
-- removed from the router later.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_provider_valid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_provider_valid
  CHECK (provider IS NULL OR provider IN (
    'openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'cloudflare',
    'nvidia', 'huggingface', 'chutes', 'sambanova', 'ollama', 'vllm'
  ));

ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_failover_from_valid;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_failover_from_valid
  CHECK (failover_from IS NULL OR failover_from IN (
    'openrouter', 'gemini', 'groq', 'cerebras', 'mistral', 'cloudflare',
    'nvidia', 'huggingface', 'chutes', 'sambanova', 'ollama', 'vllm'
  ));
