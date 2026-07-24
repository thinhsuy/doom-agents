-- 006_office_config.sql — durable console config (e.g. per-department office floor
-- choices) so a user's Office layout tweaks survive across sessions/browsers.
-- Key-value: key='floors', value = { "<division-slug>": <floor index 0..8>, ... }.
-- Written by the office-server (POST /config/floors); read on the Office tab.

CREATE TABLE IF NOT EXISTS company.office_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO company.schema_migrations (version) VALUES ('006_office_config')
  ON CONFLICT (version) DO NOTHING;
