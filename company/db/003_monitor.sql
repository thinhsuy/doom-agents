-- 003_monitor.sql — metering + pricing for the Monitor tab.
--
-- Cost is computed as usage × price. Prices are REAL (published Anthropic rates,
-- verified 2026-06-24 via the claude-api skill) and live in company.model_pricing
-- with a source column so they are auditable. Usage lands in company.usage_events;
-- until agents actually run, the only rows are the clearly-labelled ENG-001 sample.
-- Idempotent.

-- Published per-model prices, $ per 1M tokens. cache_read_mult / cache_write_mult
-- are multipliers on the input rate (reads ~0.1×, 5-min writes 1.25×).
CREATE TABLE IF NOT EXISTS company.model_pricing (
  model            text PRIMARY KEY,        -- 'claude-opus-4-8'
  provider         text NOT NULL,
  input_per_mtok   numeric(10,4) NOT NULL,
  output_per_mtok  numeric(10,4) NOT NULL,
  cache_read_mult  numeric(6,4) NOT NULL DEFAULT 0.1,
  cache_write_mult numeric(6,4) NOT NULL DEFAULT 1.25,
  note             text,
  source           text NOT NULL,
  effective_on     date,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One row per model request an agent made. tokens are raw counts; cost is derived
-- at read time by joining model_pricing, so a price correction reprices history.
CREATE TABLE IF NOT EXISTS company.usage_events (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent              text REFERENCES company.agents(slug) ON DELETE SET NULL,
  engagement_id      text REFERENCES company.engagements(id) ON DELETE CASCADE,
  task_id            text REFERENCES company.tasks(id) ON DELETE SET NULL,
  session_id         uuid REFERENCES company.sessions(id) ON DELETE SET NULL,
  model              text NOT NULL,          -- concrete model actually used
  input_tokens       int NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens      int NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens  int NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens int NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  is_sample          boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_agent_idx
  ON company.usage_events (agent, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_engagement_idx
  ON company.usage_events (engagement_id, created_at DESC);

-- Per-request cost in USD, priced from model_pricing. Unknown model (e.g. an agent
-- moved to a provider we don't price) yields NULL cost — surfaced, never guessed.
CREATE OR REPLACE VIEW company.usage_costed AS
SELECT
  u.*,
  p.provider,
  CASE WHEN p.model IS NULL THEN NULL ELSE
    u.input_tokens       / 1e6 * p.input_per_mtok
  + u.output_tokens      / 1e6 * p.output_per_mtok
  + u.cache_read_tokens  / 1e6 * p.input_per_mtok * p.cache_read_mult
  + u.cache_write_tokens / 1e6 * p.input_per_mtok * p.cache_write_mult
  END AS cost_usd,
  (p.model IS NULL) AS price_unknown
FROM company.usage_events u
LEFT JOIN company.model_pricing p ON p.model = u.model;

INSERT INTO company.schema_migrations (version) VALUES ('003_monitor')
  ON CONFLICT (version) DO NOTHING;
