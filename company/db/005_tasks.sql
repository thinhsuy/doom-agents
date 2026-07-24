-- 005_tasks.sql — task tickets agents can follow up and act on.
--
-- Adds priority + reporter to tasks and a task_comments thread (with @mentions).
-- Status changes are recorded in the existing company.status_events (the activity
-- log). The MCP task tools write here; the console drawer reads it. Idempotent.

ALTER TABLE company.tasks ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium'
  CHECK (priority IN ('low', 'medium', 'high', 'urgent'));
ALTER TABLE company.tasks ADD COLUMN IF NOT EXISTS reporter text
  REFERENCES company.agents(slug) ON DELETE SET NULL;

-- Ticket comments. mentions = agent slugs tagged in the comment (@manager etc.).
CREATE TABLE IF NOT EXISTS company.task_comments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    text NOT NULL REFERENCES company.tasks(id) ON DELETE CASCADE,
  agent      text REFERENCES company.agents(slug) ON DELETE SET NULL,
  body       text NOT NULL,
  mentions   text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_comments_task_idx
  ON company.task_comments (task_id, created_at);

INSERT INTO company.schema_migrations (version) VALUES ('005_tasks')
  ON CONFLICT (version) DO NOTHING;
