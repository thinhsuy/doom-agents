-- 029_permission_created_by.sql — track WHO created each permission / access-tool entry,
-- so the Access Tools catalog is easier to manage. Builtin (seeded) rows stay NULL = shown
-- as 'hệ thống'. Set going forward by: create_permission (the acting agent's slug) and
-- POST /api/permissions (the logged-in owner's username).
ALTER TABLE company.permissions ADD COLUMN IF NOT EXISTS created_by text;
