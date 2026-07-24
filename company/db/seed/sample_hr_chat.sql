-- sample_hr_chat.sql — the CEO/CTO ↔ HR group chat + a DEMO conversation that
-- walks the hiring pipeline (need → search → match template → create hire →
-- desk in office). Clearly sample content. Remove with:
--   DELETE FROM company.channels WHERE id='ch-hr';  (cascades its messages)
BEGIN;

-- The group chat. created_by NULL = the owner (CEO/CTO). No engagement — it is a
-- standing topic channel, so it shows in Team Chat on its own.
INSERT INTO company.channels (id, name, topic, kind, created_by)
VALUES ('ch-hr', 'HR · Tuyển dụng',
        'CEO/CTO ↔ HR: nhu cầu tuyển → pipeline (search skills/agent → khớp template → tạo agent + thêm desk)',
        'topic', NULL)
ON CONFLICT (id) DO NOTHING;

-- Demo conversation (from_agent NULL = owner). Illustrates the pipeline; the
-- Talent Lead prefers promoting an existing catalogue template over inventing one.
INSERT INTO company.messages (channel_id, from_agent, to_agent, kind, body, idempotency_key) VALUES
 ('ch-hr', NULL, 'hr-talent-acquisition-lead', 'chat',
  'Mình cần thêm một agent làm app mobile (iOS + Android). Đội mình có ai làm được chưa, hay phải tuyển mới?', 'hr-m1'),
 ('ch-hr', 'hr-talent-acquisition-lead', NULL, 'chat',
  'Để mình check bench trước. Trong 33 người biên chế hiện tại chưa có ai chuyên mobile — toàn web/backend. Vậy là cần tuyển. Mình cho Agent Sourcer đi tìm template khớp nhất.', 'hr-m2'),
 ('ch-hr', 'hr-talent-acquisition-lead', 'hr-agent-sourcer', 'handoff',
  'Role: Mobile App Developer (React Native hoặc native Swift/Kotlin). Search skills + agent template khớp nhất, kèm cả trong catalogue 251 ứng viên. Xếp shortlist theo độ khớp.', 'hr-m3'),
 ('ch-hr', 'hr-agent-sourcer', 'hr-talent-acquisition-lead', 'handoff',
  'Xong. Web: bộ skill React Native / Swift / Kotlin, CI mobile, store release. Catalogue có sẵn 2 template rất khớp: engineering-mobile-app-builder (~85% khớp) và engineering-mobile-release-engineer (release-only). Đề xuất bắt đầu từ mobile-app-builder — không cần draft từ trang trắng.', 'hr-m4'),
 ('ch-hr', 'hr-talent-acquisition-lead', NULL, 'chat',
  'Khuyến nghị: HIRE template có sẵn engineering-mobile-app-builder (khớp ~85%, đã đạt lint + originality), runtime mặc định claude-code — thay vì tạo persona mới. Rẻ hơn, ít trùng lắp. CEO/CTO duyệt không?', 'hr-m5'),
 ('ch-hr', NULL, 'hr-talent-acquisition-lead', 'ruling',
  'Duyệt. Dùng template đó, runtime mặc định.', 'hr-m6'),
 ('ch-hr', 'hr-talent-acquisition-lead', NULL, 'chat',
  'Đã thêm vào company/roster.json + rebuild (npm run data). "Mobile App Builder" giờ có trên sơ đồ tổ chức (Engineering) và tự động có một desk trong Office. Onboard xong.', 'hr-m7')
ON CONFLICT (idempotency_key) DO NOTHING;

-- A couple of acknowledgement reactions.
INSERT INTO company.message_reactions (message_id, agent, emoji)
SELECT m.id, v.agent, v.emoji FROM (VALUES
  ('hr-m4', 'hr-talent-acquisition-lead', '👍'),
  ('hr-m5', 'hr-agent-sourcer', '👍'),
  ('hr-m6', 'hr-talent-acquisition-lead', '✅')
) v(k, agent, emoji)
JOIN company.messages m ON m.idempotency_key = v.k
ON CONFLICT DO NOTHING;

COMMIT;
