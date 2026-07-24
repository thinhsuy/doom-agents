-- 012_agent_learnings.sql — self-learning: an agent accumulates skills/knowledge/
-- lessons from its OWN work experience and from CEO/CTO reminders, and those get
-- injected back into its system prompt so behaviour adapts over time. Identity is
-- SERVER-SIDE (the acting agent comes from context, never a tool arg), so an agent
-- can only adjust ITS OWN learnings — never another agent's (role scoping).

CREATE TABLE IF NOT EXISTS company.agent_learnings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent      text NOT NULL REFERENCES company.agents(slug) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'lesson'
             CHECK (kind IN ('skill','knowledge','lesson','correction')),
  content    text NOT NULL,
  source     text NOT NULL DEFAULT 'self'
             CHECK (source IN ('self','experience','owner')),   -- reflection / from a task / CEO-CTO
  task_id    text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_learnings_agent_idx
  ON company.agent_learnings (agent, created_at DESC);

INSERT INTO company.schema_migrations (version) VALUES ('012_agent_learnings')
  ON CONFLICT (version) DO NOTHING;
