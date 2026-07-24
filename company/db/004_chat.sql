-- 004_chat.sql — make Team Chat a real communication channel for agents.
--
-- Adds explicit channels (project group chats), message reactions, and per-agent
-- read state, so the MCP chat server can offer create-channel / send / react /
-- read-with-unread. Backfills one channel per existing engagement so the current
-- UI keeps working. Idempotent.

CREATE TABLE IF NOT EXISTS company.channels (
  id            text PRIMARY KEY,                 -- 'ENG-001' for engagement channels; 'ch-xxxx' for ad-hoc
  name          text NOT NULL,
  topic         text,
  kind          text NOT NULL DEFAULT 'topic'
                CHECK (kind IN ('engagement','topic','dm')),
  engagement_id text REFERENCES company.engagements(id) ON DELETE CASCADE,
  created_by    text REFERENCES company.agents(slug) ON DELETE SET NULL,
  archived      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Messages gain a channel. Nullable + backfilled so existing rows stay valid.
ALTER TABLE company.messages ADD COLUMN IF NOT EXISTS channel_id text
  REFERENCES company.channels(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS messages_channel_created_idx
  ON company.messages (channel_id, created_at DESC);

-- Reactions: one row per (message, agent, emoji). A NULL agent = the owner.
CREATE TABLE IF NOT EXISTS company.message_reactions (
  message_id bigint NOT NULL REFERENCES company.messages(id) ON DELETE CASCADE,
  agent      text REFERENCES company.agents(slug) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, agent, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_message_idx ON company.message_reactions (message_id);

-- Per-agent read cursor per channel — powers unread counts in read/list tools.
CREATE TABLE IF NOT EXISTS company.channel_reads (
  channel_id           text NOT NULL REFERENCES company.channels(id) ON DELETE CASCADE,
  agent                text NOT NULL REFERENCES company.agents(slug) ON DELETE CASCADE,
  last_read_message_id bigint,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, agent)
);

-- Backfill: one channel per engagement, id = engagement id (keeps UI rail keys).
INSERT INTO company.channels (id, name, kind, engagement_id, created_by)
SELECT e.id, e.title, 'engagement', e.id, e.opened_by
FROM company.engagements e
ON CONFLICT (id) DO NOTHING;

-- Point existing engagement messages at their channel.
UPDATE company.messages m
SET channel_id = m.engagement_id
WHERE m.channel_id IS NULL AND m.engagement_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM company.channels c WHERE c.id = m.engagement_id);

INSERT INTO company.schema_migrations (version) VALUES ('004_chat')
  ON CONFLICT (version) DO NOTHING;
