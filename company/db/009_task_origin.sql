-- 009_task_origin.sql — tasks remember WHICH chat group the directive came from,
-- so the delegation loop works from ANY group (no hardcoded channel): leads create
-- tickets while replying in a channel → origin_channel = that channel → when the
-- wave finishes, the roll-up report goes back to THAT group. ON DELETE SET NULL:
-- deleting a group keeps its tasks (history) but drops the report route.

ALTER TABLE company.tasks ADD COLUMN IF NOT EXISTS origin_channel text
  REFERENCES company.channels(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tasks_origin_channel_idx ON company.tasks (origin_channel);

INSERT INTO company.schema_migrations (version) VALUES ('009_task_origin')
  ON CONFLICT (version) DO NOTHING;
