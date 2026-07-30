-- 019_users.sql — the 3 owner accounts (CEO / CTO / COO). They SHARE all permissions
-- (no RBAC differences) — this table exists purely to give each a SEPARATE login identity
-- so a session can tell which owner is acting. Passwords are set from env
-- (AUTH_CEO_PASSWORD / AUTH_CTO_PASSWORD / AUTH_COO_PASSWORD) at backend startup and
-- stored ONLY as a pbkdf2 hash + per-user salt — never in plaintext. A NULL hash = no
-- password set yet (that account can't log in until the env var is provided).
CREATE TABLE IF NOT EXISTS company.users (
  username      text PRIMARY KEY,
  display_name  text NOT NULL,
  role          text NOT NULL,
  password_hash text,
  salt          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login    timestamptz
);

INSERT INTO company.users (username, display_name, role) VALUES
  ('ceo', 'CEO', 'CEO'),
  ('cto', 'CTO', 'CTO'),
  ('coo', 'COO', 'COO')
ON CONFLICT (username) DO NOTHING;
