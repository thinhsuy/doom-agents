-- deploy_post_build.sql — fixed data that FK-references company.agents, so it must run
-- AFTER build.py (`npm run data`) has populated the roster from the repo's .md files.
-- Same reason as standing_channels.sql: a fresh deploy applies migrations before any agent
-- rows exist, so anything pointing at an agent slug cannot live in a plain migration.
--
-- Everything here is idempotent (ON CONFLICT DO NOTHING) and guarded so a partial roster
-- never breaks the seed. Run order for a deploy:
--   1) psql -f company/db/0*.sql        (migrations — agent-independent)
--   2) python company/ui/build.py       (roster → company.agents)
--   3) psql -f company/db/seed/deploy_post_build.sql   (this file)
--   4) psql -f company/db/seed/standing_channels.sql   (standing command channels)

-- ---- Goals ("Mục tiêu" cards) — owner → company.agents(slug) -----------------
-- Only rows whose owner agent exists are inserted; build.py syncs the whole catalogue,
-- so all six owners resolve after step 2.
INSERT INTO company.goals (id, title, description, owner, status, progress, revenue_usd, target_date)
SELECT v.id, v.title, v.description, v.owner, v.status, v.progress, v.revenue_usd, v.target_date::date
FROM (VALUES
  ('G-1', 'Ra mắt cổng tự phục vụ cho khách hàng',
   'Khách hàng tự khôi phục mật khẩu & quản lý tài khoản — giảm tải support, mở doanh thu gói tự phục vụ.',
   'engagement-director', 'done', 100, 0, '2026-05-31'),
  ('G-2', 'Đóng gói & bàn giao MVP cho khách hàng đầu tiên',
   'Definition of Done đầy đủ, QA pass, tài liệu bàn giao — chốt hợp đồng khách hàng đầu tiên.',
   'product-owner', 'done', 100, 0, '2026-06-30'),
  ('G-3', 'Chuẩn hoá quy trình vận hành (SOP) toàn công ty',
   'Process mapping + DMAIC + KPI governance để mỗi engagement chạy nhất quán, giảm rework.',
   'operations-manager', 'in_progress', 60, 0, '2026-08-15'),
  ('G-4', 'Kiến trúc bảo mật zero-trust cho nền tảng',
   'Threat model + phân vùng quyền + kiểm soát secret — điều kiện để bán cho khách hàng doanh nghiệp.',
   'security-architect', 'in_progress', 35, 0, '2026-09-30'),
  ('G-5', 'Giảm 20% chi phí hạ tầng cloud',
   'Rà soát kiến trúc, right-sizing, tối ưu truy vấn — tăng biên lợi nhuận mỗi engagement.',
   'engineering-software-architect', 'at_risk', 20, 0, '2026-08-31'),
  ('G-6', 'Định giá dịch vụ & phân tích tài chính quý',
   'Mô hình chi phí-theo-task → bảng giá gói dịch vụ, dự báo dòng tiền cho quý tới.',
   'finance-financial-analyst', 'todo', 0, 0, '2026-10-15')
) AS v(id, title, description, owner, status, progress, revenue_usd, target_date)
WHERE EXISTS (SELECT 1 FROM company.agents a WHERE a.slug = v.owner)
ON CONFLICT (id) DO NOTHING;

-- ---- Access & Tools Administrator grants + runtime (agent-dependent) ----------
-- manage_access unlocks the RESTRICTED access tools; raise_decision routes high-risk /
-- self-elevation requests to the CEO/CTO as a real decision ticket.
INSERT INTO company.agent_permissions (agent, permission, granted_by)
SELECT 'access-tools-administrator', 'manage_access', NULL
WHERE EXISTS (SELECT 1 FROM company.agents WHERE slug = 'access-tools-administrator')
ON CONFLICT DO NOTHING;

INSERT INTO company.agent_permissions (agent, permission, granted_by)
SELECT 'access-tools-administrator', 'raise_decision', NULL
WHERE EXISTS (SELECT 1 FROM company.agents WHERE slug = 'access-tools-administrator')
ON CONFLICT DO NOTHING;

-- Reliable model for precise tool-calling (access changes must be done, not "announced").
INSERT INTO company.agent_runtime (slug, provider, model)
SELECT 'access-tools-administrator', 'claude', 'sonnet'
WHERE EXISTS (SELECT 1 FROM company.agents WHERE slug = 'access-tools-administrator')
ON CONFLICT (slug) DO NOTHING;
