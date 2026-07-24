-- 011_documents.sql — company knowledge base. "Document-first, implement-second":
-- every agent writes a doc describing what it's about to do so others can read &
-- follow. Stored in Postgres (agents interact via scoped MCP/API tools, never raw
-- filesystem — same role-scoping principle as tasks/chat), rendered in the console
-- Documents tab. Folders are a flat path string ("Dự án X/specs"); default format
-- is markdown so any agent can read another's output.

CREATE TABLE IF NOT EXISTS company.doc_folders (
  path        text PRIMARY KEY,
  description text,
  created_by  text REFERENCES company.agents(slug) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company.documents (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folder        text NOT NULL,
  name          text NOT NULL,
  format        text NOT NULL DEFAULT 'markdown'
                CHECK (format IN ('markdown','mermaid','ppt','text','json','code','csv','html')),
  content       text NOT NULL DEFAULT '',
  author        text REFERENCES company.agents(slug) ON DELETE SET NULL,
  engagement_id text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (folder, name)                       -- write_doc is create-or-update on this key
);
CREATE INDEX IF NOT EXISTS documents_folder_idx ON company.documents (folder);

INSERT INTO company.schema_migrations (version) VALUES ('011_documents')
  ON CONFLICT (version) DO NOTHING;
