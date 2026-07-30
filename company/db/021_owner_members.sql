-- 021_owner_members.sql — make the 3 owner accounts (CEO/CTO/COO) first-class MEMBERS:
-- addable to group chats, @mentionable, and task-assignable. The membership + task FKs
-- point at company.agents(slug), so owners need agent rows to be referenced. They are
-- flagged is_owner=true — they are HUMANS, and every LLM auto-reply / worker path excludes
-- is_owner, so tagging @CEO or assigning a task to CEO NEVER makes an AI act as them.
-- They deliberately have NO persona file, so build.py (which exports agents.json from the
-- repo's .md files) keeps them OUT of the agent directory / office / roster stats.
ALTER TABLE company.agents ADD COLUMN IF NOT EXISTS is_owner boolean NOT NULL DEFAULT false;

INSERT INTO company.agents (slug, name, division, hired, is_owner, emoji, color, description) VALUES
  ('ceo', 'CEO', 'executive', true, true, '👑', 'indigo', 'Chief Executive Officer (người thật, không phải agent AI)'),
  ('cto', 'CTO', 'executive', true, true, '🛠️', 'indigo', 'Chief Technology Officer (người thật, không phải agent AI)'),
  ('coo', 'COO', 'executive', true, true, '⚙️', 'indigo', 'Chief Operating Officer (người thật, không phải agent AI)')
ON CONFLICT (slug) DO UPDATE SET is_owner = true, hired = true;
