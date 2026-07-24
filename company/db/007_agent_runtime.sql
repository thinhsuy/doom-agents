-- 007_agent_runtime.sql — per-agent provider + model (which LLM answers as this
-- agent). Two providers: 'gpt' (OpenAI) and 'claude' (AWS Bedrock). model is a
-- short alias (gpt-4o-mini / gpt-4o / haiku / sonnet); the backend maps Claude
-- aliases to Bedrock model IDs. Absent row = the company default.

CREATE TABLE IF NOT EXISTS company.agent_runtime (
  slug       text PRIMARY KEY REFERENCES company.agents(slug) ON DELETE CASCADE,
  provider   text NOT NULL CHECK (provider IN ('gpt', 'claude')),
  model      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO company.schema_migrations (version) VALUES ('007_agent_runtime')
  ON CONFLICT (version) DO NOTHING;
