-- sample_tasks.sql — DEMO task detail for the Tasks tab: priority, reporter,
-- ticket comments, and status history. Clearly a sample (all on ENG-001 tasks).
-- Remove with:  DELETE FROM company.engagements WHERE id='ENG-001';  (cascades)
--
-- Idempotent: the UPDATEs are set-to-constant; comments/history use NOT EXISTS
-- guards so re-running never duplicates a row (they have no natural unique key).
BEGIN;

-- Backfill detail/priority/reporter on tasks seeded before migration 005 ran.
-- (A from-scratch seed already carries these via sample_engagement.sql.)
UPDATE company.tasks SET reporter = 'project-manager-senior'
  WHERE engagement_id = 'ENG-001' AND reporter IS NULL;
UPDATE company.tasks SET priority = v.priority, detail = coalesce(tasks.detail, v.detail)
  FROM (VALUES
    ('T-101','high',   'Bảng RecoveryToken: token băm (không lưu plaintext), user_id, expires_at (now()+15p), used_at nullable. 1 token sống / user.'),
    ('T-102','high',   'POST /recovery: nhận email → phát token, gửi mail. Cần log timing + enumeration để QA kiểm.'),
    ('T-103','medium', '2 màn: nhập email yêu cầu reset; redeem token + đặt mật khẩu mới. Copy nút chờ PO chốt.'),
    ('T-104','high',   'Email tồn tại hay không đều trả cùng response và cùng timing. Đang chặn bởi A2.'),
    ('T-105','urgent', 'Trong 60s kể từ token gần nhất, request mới phải trả LẠI token cũ. QA fail 2 lần.'),
    ('T-106','low',    'Kênh SMS song song email. Hoãn: ngoài phạm vi đợt tháng 9.')
  ) AS v(id, priority, detail)
  WHERE tasks.id = v.id AND tasks.engagement_id = 'ENG-001';

-- Ticket comments (agents follow up on a task). mentions = tagged agent slugs.
INSERT INTO company.task_comments (task_id, agent, body, mentions)
SELECT v.task_id, v.agent, v.body, v.mentions FROM (VALUES
  ('T-102','project-manager-senior','Ưu tiên cao — T-103 (frontend) đang chờ endpoint này. @engineering-backend-architect ping mình khi sẵn sàng mời QA.', ARRAY['engineering-backend-architect']),
  ('T-102','engineering-backend-architect','Đã mời QA. Bằng chứng ở company/evidence/T-102/ (timing.log, enumeration.log).', ARRAY[]::text[]),
  ('T-105','testing-evidence-collector','FAIL 2/3: cooldown chưa chặn request thứ 2 trong 60s → tạo token thứ hai. Xem repeat.log. @engineering-backend-architect chỉ cần sửa đúng tiêu chí này, còn 1 lượt.', ARRAY['engineering-backend-architect']),
  ('T-105','engineering-backend-architect','Đã thấy. Do check cooldown chạy sau khi insert token. Đảo thứ tự + khoá theo user. Sửa xong xin QA lại.', ARRAY[]::text[]),
  ('T-104','engagement-director','Chặn bởi A2 — cần owner quyết support xem *thời điểm* hay chỉ *số lần*. @project-manager-senior giữ task ở todo tới khi có phán quyết.', ARRAY['project-manager-senior'])
) AS v(task_id, agent, body, mentions)
WHERE NOT EXISTS (
  SELECT 1 FROM company.task_comments c WHERE c.task_id = v.task_id AND c.body = v.body
);

-- Status history (the activity log the drawer reads). Append-only audit.
INSERT INTO company.status_events (entity_type, entity_id, from_status, to_status, changed_by, reason)
SELECT 'task', v.id, v.from_status, v.to_status, v.changed_by, v.reason FROM (VALUES
  ('T-101', 'todo',        'in_progress', 'engineering-backend-architect', 'Nhận task từ backlog (RICE).'),
  ('T-101', 'in_progress', 'in_qa',       'engineering-backend-architect', 'Xong schema, mời QA.'),
  ('T-101', 'in_qa',       'accepted',    'product-owner',                 'PO chấp nhận: khớp tiêu chí R-042.1.'),
  ('T-102', 'todo',        'in_progress', 'engineering-backend-architect', 'Bắt đầu sau khi T-101 xong.'),
  ('T-102', 'in_progress', 'in_qa',       'engineering-backend-architect', 'Mời QA kèm bằng chứng.'),
  ('T-105', 'in_progress', 'in_qa',       'engineering-backend-architect', 'Xin QA lượt 1.'),
  ('T-105', 'in_qa',       'rejected',    'testing-evidence-collector',    'FAIL 1/3: race trong 60s.'),
  ('T-105', 'rejected',    'in_progress', 'engineering-backend-architect', 'Sửa lại, xin QA lượt 2.'),
  ('T-105', 'in_qa',       'rejected',    'testing-evidence-collector',    'FAIL 2/3: cooldown vẫn chưa chặn.')
) AS v(id, from_status, to_status, changed_by, reason)
WHERE NOT EXISTS (
  SELECT 1 FROM company.status_events e
  WHERE e.entity_type = 'task' AND e.entity_id = v.id
    AND e.to_status = v.to_status AND coalesce(e.reason,'') = v.reason
);

COMMIT;
