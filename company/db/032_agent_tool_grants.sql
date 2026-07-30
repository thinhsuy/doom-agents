-- 032_agent_tool_grants.sql — grant INDIVIDUAL tools to an agent (fine-grained), alongside
-- the coarse permission bundles in company.agent_permissions. An agent's effective granted
-- tools = (tools from its granted permissions) ∪ (these direct tool grants). Lets the owner
-- give an agent exactly one tool (e.g. assign_task) without the whole create_task bundle.
CREATE TABLE IF NOT EXISTS company.agent_tool_grants (
  agent      text NOT NULL REFERENCES company.agents(slug) ON DELETE CASCADE,
  tool       text NOT NULL,
  granted_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, tool)
);
