-- 018_access_admin.sql — the access-management capability + the Access & Tools
-- Administrator's grant. `manage_access` unlocks the RESTRICTED access tools
-- (grant_permission / revoke_permission / create_permission). It is high_risk so NO agent
-- can grant it to another (only the CEO/CTO, via the Access Tools tab) — the admin can't
-- self-replicate. Requires the agent row (created by `npm run data` from the .md + roster).
INSERT INTO company.permissions (key,label,description,tools,high_risk,builtin,sort) VALUES
 ('manage_access','Quản trị quyền & access-tools',
  'Cấp/thu quyền tool cho agent và tạo quyền mới trong danh mục (least-privilege). Quyền rủi ro cao và việc tự-nhân-bản admin vẫn phải CEO/CTO duyệt.',
  ARRAY['grant_permission','revoke_permission','create_permission'], true, true, 90)
ON CONFLICT (key) DO NOTHING;

-- The manage_access PERMISSION (above) is agent-independent, so it lives here. Granting it
-- (plus raise_decision) TO the Access & Tools Administrator and pinning that agent's runtime
-- are agent-dependent (FK → company.agents), so they are seeded in seed/deploy_post_build.sql
-- after build.py populates the roster — the same reason the goal rows moved there.
