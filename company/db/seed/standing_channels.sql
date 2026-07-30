-- standing_channels.sql — the standing command channels (Leadership + HR hiring) with their
-- agent members. RUN AFTER build.py (`npm run data`), because channel_members FK to
-- company.agents and build.py is what populates the roster from the repo's .md files.
--
-- Idempotent: channels ON CONFLICT DO NOTHING; each membership row is added only if that
-- agent exists (WHERE EXISTS), so a partial roster never breaks the seed. Owner 'ceo' is a
-- member so the CEO sees these groups on first login (add CTO/COO later in the UI).
--
-- This seeds the channels' STRUCTURE only (no sample messages). The sample_*.sql files are
-- demo content and are intentionally NOT part of a deploy.

INSERT INTO company.channels (id, name, topic, kind) VALUES
  ('ch-leadership', 'Ban lãnh đạo · Giao việc',
   'CEO/CTO giao việc cho lead/manager → lead giao task cho staff (ticket, cap 3, QA gác cổng) → lead báo cáo lại CEO/CTO', 'topic'),
  ('ch-hr-tuyen-dung', 'HR - Tuyển dụng',
   'Tuyển dụng nhân viên (staff agent mới) dựa theo yêu cầu của CEO/CTO', 'topic')
ON CONFLICT (id) DO NOTHING;

INSERT INTO company.channel_members (channel_id, agent)
SELECT c.cid, c.agent FROM (VALUES
  ('ch-leadership', 'ceo'),
  ('ch-leadership', 'engagement-director'),
  ('ch-leadership', 'project-manager-senior'),
  ('ch-leadership', 'product-owner'),
  ('ch-leadership', 'engineering-software-architect'),
  ('ch-leadership', 'security-architect'),
  ('ch-hr-tuyen-dung', 'ceo'),
  ('ch-hr-tuyen-dung', 'hr-talent-acquisition-lead'),
  ('ch-hr-tuyen-dung', 'operations-manager'),
  ('ch-hr-tuyen-dung', 'access-tools-administrator')
) AS c(cid, agent)
WHERE EXISTS (SELECT 1 FROM company.agents a WHERE a.slug = c.agent)
ON CONFLICT DO NOTHING;
