-- 033_permission_is_base.sql — make the "cơ bản" (base) designation MANAGEABLE. A permission
-- flagged is_base is auto-granted to EVERY hired agent (its tools offered to all). Previously
-- this set was hardcoded in main.py (_BASE_PERM_KEYS); now the owner can toggle it per group in
-- the Access Tools editor. Seed the current 5 base groups so behaviour is unchanged.
ALTER TABLE company.permissions ADD COLUMN IF NOT EXISTS is_base boolean NOT NULL DEFAULT false;
UPDATE company.permissions SET is_base = true
 WHERE key IN ('view_db', 'read_docs', 'write_docs', 'record_learning', 'web_search');
