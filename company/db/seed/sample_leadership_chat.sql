-- sample_leadership_chat.sql — the CEO/CTO ↔ leads/managers "command" group + a
-- DEMO that walks the delegation loop the owner asked for:
--   CEO/CTO giao việc cho lead/manager
--     → lead/manager phân task cho các agent staff (task ticket, attempt cap 3, QA gác cổng)
--       → lead/manager báo cáo (roll-up) lại cho CEO/CTO trong chính group này.
-- Clearly sample content. Remove with:
--   DELETE FROM company.channels WHERE id='ch-leadership';  (cascades its messages)
BEGIN;

-- The standing leadership channel. created_by NULL = the owner (CEO/CTO). No
-- engagement — it is a standing topic channel, so it shows in Team Chat on its own.
INSERT INTO company.channels (id, name, topic, kind, created_by)
VALUES ('ch-leadership', 'Ban lãnh đạo · Giao việc',
        'CEO/CTO giao việc cho lead/manager → lead giao task cho staff (ticket, cap 3, QA gác cổng) → lead báo cáo lại CEO/CTO',
        'topic', NULL)
ON CONFLICT (id) DO NOTHING;

-- Demo conversation (from_agent NULL = owner). Shows the full command loop end to
-- end for a concrete thin slice (SSO login). Leads assign DOWN to staff via task
-- tickets and report UP to the CEO/CTO in this same group.
INSERT INTO company.messages (channel_id, from_agent, to_agent, kind, body, idempotency_key) VALUES
 ('ch-leadership', NULL, 'engagement-director', 'chat',
  'Ban lãnh đạo: khách cần thêm đăng nhập SSO (Google) cho web app. Tuần này mình cần một thin slice chạy được. Các lead chia việc, ước lượng, phân cho staff, rồi báo cáo lại cho mình ngay trong group này.', 'lead-m1'),
 ('ch-leadership', 'engagement-director', NULL, 'chat',
  'Rõ. Chia 3 luồng: (1) spec + Definition of Done, (2) build BE/FE, (3) QA gác cổng. Route: PM Senior lập backlog + phân task cho dev; Software Architect chốt kiến trúc SSO; Product Owner chốt DoD; Security Architect review threat model. Mình sẽ roll-up báo CEO/CTO cuối ngày.', 'lead-m2'),
 ('ch-leadership', 'engagement-director', 'project-manager-senior', 'handoff',
  'PM: chuyển spec SSO thành task ticket, phân cho dev, giữ attempt cap 3 + QA gác cổng. Cần backlog trong hôm nay.', 'lead-m3'),
 ('ch-leadership', 'product-owner', NULL, 'chat',
  'DoD cho slice này: (a) user Google login thành công, (b) session tạo đúng (cookie httpOnly), (c) sai domain bị chặn, (d) test tự động xanh + bằng chứng đính kèm. Thiếu bất kỳ ý nào = reject.', 'lead-m4'),
 ('ch-leadership', 'engineering-software-architect', NULL, 'chat',
  'Kiến trúc: OAuth2 Authorization Code + PKCE, callback /auth/callback, session cookie httpOnly. Đã ghi chi tiết vào ticket. Không tự phát sinh yêu cầu ngoài spec.', 'lead-m5'),
 ('ch-leadership', 'project-manager-senior', NULL, 'chat',
  'Đã tạo 3 task ticket và phân cho staff: T-201 backend OAuth → @Senior Developer; T-202 nút + luồng redirect → @Frontend Developer; T-203 test e2e → @Test Automation Engineer. Evidence Collector gác cổng gate. Bắt đầu ngay.', 'lead-m6'),
 ('ch-leadership', 'security-architect', NULL, 'chat',
  'Threat model xong: bắt buộc state/nonce chống CSRF, domain whitelist, không log token. Đã thêm 2 check này vào T-201 và T-203.', 'lead-m7'),
 ('ch-leadership', 'project-manager-senior', NULL, 'chat',
  'Cập nhật: T-201 accepted. T-202 đang review (QA fail lần 1 — thiếu chặn domain sai; dev đang sửa, attempt 2/3). T-203 đang chạy. Chưa có blocker.', 'lead-m8'),
 ('ch-leadership', 'product-owner', NULL, 'chat',
  'Đã accept T-201 (bằng chứng đủ, khớp DoD). T-202 giữ ở review tới khi QA xanh.', 'lead-m9'),
 ('ch-leadership', 'engagement-director', NULL, 'chat',
  '📋 Báo cáo CEO/CTO: slice SSO — 1/3 accepted, 2/3 đang QA vòng 2, 1 test đang chạy. Dự kiến accepted hết trong hôm nay. Budget trong hạn, không có escalation. CEO/CTO cần duyệt thêm gì không?', 'lead-m10'),
 ('ch-leadership', NULL, 'engagement-director', 'ruling',
  'Tốt. Duyệt tiếp. Xong slice thì demo cho mình.', 'lead-m11'),
 ('ch-leadership', 'engagement-director', NULL, 'chat',
  'Rõ. Sẽ báo lại khi tất cả task accepted và có bản demo chạy được.', 'lead-m12')
ON CONFLICT (idempotency_key) DO NOTHING;

-- A few acknowledgement reactions.
INSERT INTO company.message_reactions (message_id, agent, emoji)
SELECT m.id, v.agent, v.emoji FROM (VALUES
  ('lead-m2', 'project-manager-senior',        '👍'),
  ('lead-m3', 'project-manager-senior',        '✅'),
  ('lead-m6', 'engagement-director',           '👍'),
  ('lead-m9', 'engagement-director',           '✅'),
  ('lead-m10', 'product-owner',                '👍')
) v(k, agent, emoji)
JOIN company.messages m ON m.idempotency_key = v.k
ON CONFLICT DO NOTHING;

COMMIT;
