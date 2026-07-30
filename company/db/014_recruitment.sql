-- 014_recruitment.sql — the HIRING PIPELINE as a first-class, owner-approved workflow.
--
-- (1) hire_candidates: a proposed staff hire. TAL (or the sourcing pipeline) drafts a
--     card — persona brief, skills, proposed provider/division, and the PERMISSIONS the
--     new agent would need (write_file, read internal docs, …). The CEO/CTO reviews the
--     card in the "Tuyển dụng" tab, may edit every field, TICKS which permissions to
--     grant, then approves (→ hire) or rejects. Nothing is installed without that tick.
--
-- (2) agent_permissions: the capabilities actually GRANTED to an agent, keyed per-agent.
--     _tool_names_for() unions these with the default toolset, so an approved hire gets
--     exactly (and only) the tools the owner ticked — role-scoping stays intact.
CREATE TABLE IF NOT EXISTS company.hire_candidates (
  id            text PRIMARY KEY,                    -- H-1, H-2, …
  source_slug   text,                                -- catalogue agent to hire; NULL = brand-new persona
  name          text NOT NULL,                       -- display name
  division      text NOT NULL DEFAULT 'specialized', -- catalogue division / department
  hire_group    text,                                -- roster group label (e.g. "Tài chính")
  brief         text,                                -- short persona summary shown on the card
  skills        text[] NOT NULL DEFAULT '{}',
  provider      text NOT NULL DEFAULT 'claude',
  model         text NOT NULL DEFAULT 'sonnet',
  requested_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{key,label,why}] proposed by TAL
  granted_permissions   text[] NOT NULL DEFAULT '{}',        -- keys the CEO/CTO ticked on approve
  proposed_by   text,                                 -- agent slug that raised it (TAL)
  status        text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','approved','rejected')),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hire_candidates_status_idx ON company.hire_candidates (status);

CREATE TABLE IF NOT EXISTS company.agent_permissions (
  agent      text NOT NULL,
  permission text NOT NULL,
  granted_by text,                                    -- NULL = the owner
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent, permission)
);
