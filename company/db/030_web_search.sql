-- 030_web_search.sql — register the base 'web_search' capability in the catalog so it shows
-- in the Access Tools list (like view_db / read_docs). Every hired agent has it — the tool
-- `search_web` is Access.EVERYONE in the registry — so this row is the catalog/display entry.
INSERT INTO company.permissions (key, label, description, tools, high_risk, builtin, sort) VALUES
 ('web_search', 'Tìm kiếm web',
  'Tìm thông tin trên Internet (DuckDuckGo, không cần key) — mọi agent đều có.',
  ARRAY['search_web'], false, true, 45)
ON CONFLICT (key) DO NOTHING;
