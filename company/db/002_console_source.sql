-- 002_console_source.sql — make Postgres the source the console reads from.
--
-- Adds the columns the read-only console needs so `build.py` can EXPORT the
-- console's data straight out of the DB instead of the app hardcoding it.
-- Idempotent.

-- agents: keep the typed columns for querying (SELECT name WHERE hired), and add
-- one `doc jsonb` holding the exact console object. Export = json_agg(doc); the
-- typed columns stay queryable. Agent bodies are NOT stored — only description,
-- section headers, and word count (the console never showed the full body).
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS emoji       text;
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS color       text;
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS vibe        text;
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS hired_why   text;
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS doc         jsonb NOT NULL DEFAULT '{}'::jsonb;

-- decisions: the operational fields the owner reviews. why_owner already exists;
-- we standardise on why_you to match the app. raised_at is the semantic date the
-- decision was raised (distinct from created_at, the DB insert time).
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS why_you             text;
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS raised_at           date;
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS blocks              text[] NOT NULL DEFAULT '{}';
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS cost_of_not_deciding text;
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS raised_by_name      text;
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS raised_by_emoji     text;

INSERT INTO company.schema_migrations (version) VALUES ('002_console_source')
  ON CONFLICT (version) DO NOTHING;
