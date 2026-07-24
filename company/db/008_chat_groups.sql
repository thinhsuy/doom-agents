-- 008_chat_groups.sql — group-chat membership + owner reactions.
--
-- (1) channel_members: which agents belong to a chat group. Mention autocomplete
--     is scoped to members; a no-mention owner message triggers ALL members and
--     each agent decides to answer or PASS (real-office behavior). Channels with
--     no member rows keep the old behavior (no auto-trigger).
-- (2) message_reactions.agent becomes nullable so the OWNER (CEO/CTO) can react:
--     the original PRIMARY KEY forced agent NOT NULL. Replaced by a unique
--     expression index treating NULL as '(owner)'. Idempotent.

CREATE TABLE IF NOT EXISTS company.channel_members (
  channel_id text NOT NULL REFERENCES company.channels(id) ON DELETE CASCADE,
  agent      text NOT NULL REFERENCES company.agents(slug) ON DELETE CASCADE,
  added_by   text,                               -- NULL = the owner added them
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, agent)
);
CREATE INDEX IF NOT EXISTS channel_members_agent_idx ON company.channel_members (agent);

-- Owner reactions: drop the PK (kept agent NOT NULL), allow NULL, dedupe by index.
ALTER TABLE company.message_reactions DROP CONSTRAINT IF EXISTS message_reactions_pkey;
ALTER TABLE company.message_reactions ALTER COLUMN agent DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS message_reactions_uniq
  ON company.message_reactions (message_id, coalesce(agent, '(owner)'), emoji);

-- Seed members for the standing command channels (only if they exist).
INSERT INTO company.channel_members (channel_id, agent)
SELECT v.c, v.a FROM (VALUES
  ('ch-hr', 'hr-talent-acquisition-lead'),
  ('ch-hr', 'hr-agent-sourcer'),
  ('ch-leadership', 'engagement-director'),
  ('ch-leadership', 'project-manager-senior'),
  ('ch-leadership', 'product-owner'),
  ('ch-leadership', 'engineering-software-architect'),
  ('ch-leadership', 'security-architect')
) AS v(c, a)
WHERE EXISTS (SELECT 1 FROM company.channels ch WHERE ch.id = v.c)
  AND EXISTS (SELECT 1 FROM company.agents ag WHERE ag.slug = v.a)
ON CONFLICT DO NOTHING;

INSERT INTO company.schema_migrations (version) VALUES ('008_chat_groups')
  ON CONFLICT (version) DO NOTHING;
