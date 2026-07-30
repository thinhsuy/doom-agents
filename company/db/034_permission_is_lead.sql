-- 034_permission_is_lead.sql — make the "LEAD" designation MANAGEABLE (parity with is_base).
-- A permission flagged is_lead is auto-granted to every LEAD (WRITE_SLUGS) — its tools offered
-- to all leads. Previously hardcoded in main.py (_LEAD_PERM_KEYS); now toggleable in the editor.
-- Seed the current 2 lead groups so behaviour is unchanged.
ALTER TABLE company.permissions ADD COLUMN IF NOT EXISTS is_lead boolean NOT NULL DEFAULT false;
UPDATE company.permissions SET is_lead = true WHERE key IN ('create_task', 'raise_decision');
