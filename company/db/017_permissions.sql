-- 017_permissions.sql — the ONE canonical catalog of grantable permissions / access-tools.
-- Before this, the list lived hardcoded in main.py (GRANTABLE_PERMS + PERM_TO_TOOLS) and
-- was referenced by the Tuyển dụng flow only. Promoting it to a table makes it the single
-- source of truth referenced by Providers (Access Tools column), Tuyển dụng (permission
-- checkboxes) and the new Access Tools settings tab — add/remove a permission in ONE place.
-- `tools` = the backend tool names a permission unlocks (empty = a recorded grant honored
-- by the orchestrator, e.g. hire_agent/write_file — no LLM-callable tool).
CREATE TABLE IF NOT EXISTS company.permissions (
  key         text PRIMARY KEY,
  label       text NOT NULL,
  description text,
  tools       text[] NOT NULL DEFAULT '{}',
  high_risk   boolean NOT NULL DEFAULT false,
  builtin     boolean NOT NULL DEFAULT false,   -- core perms: editable but not deletable
  sort        int NOT NULL DEFAULT 100,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO company.permissions (key,label,description,tools,high_risk,builtin,sort) VALUES
 ('view_db','Đọc dữ liệu công ty','Truy vấn các view chỉ-đọc: overview, agents, tasks, channels, engagements, candidates.',ARRAY['view_db'],false,true,10),
 ('read_docs','Đọc tài liệu nội bộ','Xem kho tài liệu công ty.',ARRAY['list_docs','read_doc'],false,true,20),
 ('write_docs','Ghi / sửa tài liệu nội bộ','Tạo & cập nhật tài liệu, tạo thư mục.',ARRAY['create_folder','write_doc'],false,true,30),
 ('record_learning','Tự học / điều chỉnh kỹ năng','Ghi lại skill / knowledge / lesson cho chính mình.',ARRAY['record_learning'],false,true,40),
 ('create_task','Tạo & giao task','Tạo ticket, gán PIC, comment, đổi trạng thái task.',ARRAY['create_task','assign_task','comment_task','update_task_status'],false,true,50),
 ('raise_decision','Tạo ticket quyết định','Đưa quyết định cần CEO/CTO phê duyệt.',ARRAY['raise_decision'],false,true,60),
 ('hire_agent','Tuyển agent vào biên chế','Quyền cao — thực thi qua orchestrator/Claude Code (không có tool LLM trực tiếp).',ARRAY[]::text[],true,true,70),
 ('write_file','Ghi file mã nguồn','RẤT cao — thực thi qua orchestrator/Claude Code (không có tool LLM ghi file).',ARRAY[]::text[],true,true,80)
ON CONFLICT (key) DO NOTHING;

-- Tie per-agent grants to the catalog: drop orphan grants, then add a cascading FK so
-- deleting a permission cleanly revokes it everywhere. Guarded → idempotent.
DELETE FROM company.agent_permissions ap
 WHERE NOT EXISTS (SELECT 1 FROM company.permissions p WHERE p.key = ap.permission);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='agent_permissions_permission_fkey') THEN
    ALTER TABLE company.agent_permissions
      ADD CONSTRAINT agent_permissions_permission_fkey
      FOREIGN KEY (permission) REFERENCES company.permissions(key) ON DELETE CASCADE;
  END IF;
END $$;
