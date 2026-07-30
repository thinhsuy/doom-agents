-- 039_propose_hire.sql — TAL (and other leads) propose hires into company.hire_candidates
-- via the LLM tool `propose_hire`. Cards land in the Tuyển dụng tab for CEO/CTO approve/reject.
-- Without this permission+tool, agents fell back to write_doc (Documents) and bypassed the pipeline.
INSERT INTO company.permissions (key, label, description, tools, high_risk, builtin, sort, is_lead)
VALUES (
  'propose_hire',
  'Đề xuất ứng viên tuyển dụng',
  'Tạo card ứng viên (status=proposed) vào tab Tuyển dụng để CEO/CTO duyệt. Không tự thêm vào roster.',
  ARRAY['propose_hire'],
  false,
  true,
  65,
  true
)
ON CONFLICT (key) DO UPDATE SET
  tools = EXCLUDED.tools,
  is_lead = true,
  label = EXCLUDED.label,
  description = EXCLUDED.description;

INSERT INTO company.schema_migrations (version) VALUES ('039_propose_hire')
  ON CONFLICT (version) DO NOTHING;
