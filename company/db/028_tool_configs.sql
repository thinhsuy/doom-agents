-- 028_tool_configs.sql — agent-authored TOOL DEFINITIONS (the "tools configuration list").
--
-- Staff agents can PROPOSE a new tool with the `create_tool` tool (a declarative spec:
-- name + description + params). This is data, NOT executable code — an LLM authoring
-- arbitrary Python would be remote code execution and would defeat role-scoping. A proposed
-- tool is inert until the CEO/CTO or the Access & Tools Administrator ACTIVATES it.
--
-- Active tools are offered to agents in the reply loop; invoking one RECORDS the request
-- into tool_invocations for the orchestrator/owner to honour — the same "recorded grant"
-- pattern already used for write_file/hire_agent. No custom code ever runs on the server.

CREATE TABLE IF NOT EXISTS company.tool_configs (
  name         text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]{1,39}$'),
  label        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  category     text NOT NULL DEFAULT 'custom',
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- JSON-Schema "properties" (declarative)
  status       text NOT NULL DEFAULT 'proposed'
                 CHECK (status IN ('proposed','active','rejected')),
  created_by   text REFERENCES company.agents(slug),
  created_at   timestamptz NOT NULL DEFAULT now(),
  activated_by text,
  activated_at timestamptz
);
CREATE INDEX IF NOT EXISTS tool_configs_status_idx ON company.tool_configs (status);

-- Audit of every active-custom-tool invocation (the "recorded" execution).
CREATE TABLE IF NOT EXISTS company.tool_invocations (
  id         bigserial PRIMARY KEY,
  tool       text NOT NULL,
  agent      text,
  task_id    text,
  args       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_invocations_tool_idx ON company.tool_invocations (tool, id DESC);

-- set_tool_status (activate/reject a proposed tool) is a RESTRICTED admin capability →
-- unlock it via the existing manage_access permission (access-tools-administrator).
UPDATE company.permissions
   SET tools = (SELECT array_agg(DISTINCT t) FROM unnest(tools || ARRAY['set_tool_status']) t)
 WHERE key = 'manage_access';
