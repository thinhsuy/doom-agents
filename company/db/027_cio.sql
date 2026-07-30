-- 027_cio.sql — add a 4th owner: CIO (Chief Information Officer). Owners SHARE all
-- permissions; this only adds a separate LOGIN identity (company.users) + a first-class
-- MEMBER row (company.agents, is_owner) — exactly like CEO/CTO/COO in migrations 019 + 021.
-- Password is set from AUTH_CIO_PASSWORD at backend startup (NULL until then = can't log in).
-- is_owner=true → every LLM auto-reply / worker path excludes it, so @CIO never makes an AI
-- act as the human. No persona file, so build.py keeps it out of the agent directory/office.
-- Idempotent.
INSERT INTO company.users (username, display_name, role) VALUES
  ('cio', 'CIO', 'CIO')
ON CONFLICT (username) DO NOTHING;

INSERT INTO company.agents (slug, name, division, hired, is_owner, emoji, color, description) VALUES
  ('cio', 'CIO', 'executive', true, true, '🗄️', 'indigo', 'Chief Information Officer (người thật, không phải agent AI)')
ON CONFLICT (slug) DO UPDATE SET is_owner = true, hired = true;
