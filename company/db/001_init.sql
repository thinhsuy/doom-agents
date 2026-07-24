-- 001_init.sql — system of record for the virtual company.
--
-- Applied to database `doom_agents`, schema `company`.
-- Idempotent: safe to re-run.
--
-- Design notes:
--   * timestamptz everywhere — never bare timestamp.
--   * status values are text + CHECK, not native enums, so adding a state is a
--     plain migration instead of an ALTER TYPE that locks.
--   * invariants that must always hold are CHECK constraints, not conventions:
--     a decision cannot be 'decided' without a ruling; a task cannot exceed the
--     NEXUS 3-attempt cap.
--   * messages carry an idempotency_key so an at-least-once writer that retries
--     cannot duplicate a handoff.

CREATE SCHEMA IF NOT EXISTS company;

CREATE TABLE IF NOT EXISTS company.schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- agents
-- Roster snapshot, synced from the repo (company/roster.json + the catalog).
CREATE TABLE IF NOT EXISTS company.agents (
  slug          text PRIMARY KEY,
  name          text NOT NULL,
  division      text NOT NULL,
  hired         boolean NOT NULL DEFAULT false,
  hired_group   text,
  runtime_tool  text NOT NULL DEFAULT 'claude-code',
  runtime_model text NOT NULL DEFAULT 'inherit',
  tools         text[] NOT NULL DEFAULT '{}',
  synced_at     timestamptz NOT NULL DEFAULT now()
);

-- Two hired agents sharing a display name shadow each other once installed into
-- ~/.claude/agents. Enforce it here so a bad sync fails instead of silently
-- half-staffing the company. Un-hired duplicates in the catalog are tolerated.
CREATE UNIQUE INDEX IF NOT EXISTS agents_hired_name_uniq
  ON company.agents (name) WHERE hired;

-- ---------------------------------------------------------- engagements
CREATE TABLE IF NOT EXISTS company.engagements (
  id                text PRIMARY KEY,                 -- ENG-007
  title             text NOT NULL,
  request_verbatim  text NOT NULL,                    -- the owner's exact words
  outcome           text,
  success_condition text,
  mode              text NOT NULL DEFAULT 'micro'
                    CHECK (mode IN ('micro', 'sprint', 'full')),
  status            text NOT NULL DEFAULT 'intake'
                    CHECK (status IN ('intake','spec','build','qa','delivered','cancelled')),
  decider           text,
  budget_note       text,
  opened_by         text REFERENCES company.agents(slug) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz,
  CONSTRAINT engagement_closed_has_time
    CHECK (status NOT IN ('delivered','cancelled') OR closed_at IS NOT NULL)
);

-- ------------------------------------------------------------- sessions
-- One row per Claude Code run that touched an engagement. This is what makes
-- work resumable: a fresh session reads state from here, not from chat history.
CREATE TABLE IF NOT EXISTS company.sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text UNIQUE,                        -- Claude Code session id, if known
  engagement_id text REFERENCES company.engagements(id) ON DELETE CASCADE,
  label         text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT session_end_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- ---------------------------------------------------------------- tasks
CREATE TABLE IF NOT EXISTS company.tasks (
  id             text PRIMARY KEY,                  -- T-118
  engagement_id  text NOT NULL REFERENCES company.engagements(id) ON DELETE CASCADE,
  requirement_id text,                              -- R-042.1, from the BA's spec
  title          text NOT NULL,
  detail         text,
  assignee       text REFERENCES company.agents(slug) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','in_qa','rejected','accepted','deferred','escalated')),
  -- NEXUS: max 3 attempts, then escalate. Encoded, not remembered.
  attempt        int NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
  blocked_by     text,                              -- ambiguity id, e.g. A1
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT task_orphan_forbidden CHECK (requirement_id IS NULL OR length(requirement_id) > 0)
);

-- ------------------------------------------------------------- messages
-- Agent-to-agent communication: team chat, handoffs, QA verdicts, escalations.
-- from_agent / to_agent NULL means the owner (CEO/CTO) — the human is not an agent.
CREATE TABLE IF NOT EXISTS company.messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      uuid REFERENCES company.sessions(id) ON DELETE SET NULL,
  engagement_id   text REFERENCES company.engagements(id) ON DELETE CASCADE,
  task_id         text REFERENCES company.tasks(id) ON DELETE CASCADE,
  from_agent      text REFERENCES company.agents(slug) ON DELETE SET NULL,
  to_agent        text REFERENCES company.agents(slug) ON DELETE SET NULL,
  kind            text NOT NULL DEFAULT 'chat'
                  CHECK (kind IN ('chat','handoff','qa_verdict','escalation','ruling','note')),
  body            text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- A retrying writer must not duplicate a handoff. Derive from content, not a clock.
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- status_events
-- Append-only audit of every state transition. Answers "how did this get here?"
CREATE TABLE IF NOT EXISTS company.status_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('engagement','task','decision')),
  entity_id   text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  changed_by  text,                                 -- agent slug, or 'owner'
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ decisions
CREATE TABLE IF NOT EXISTS company.decisions (
  id             text PRIMARY KEY,                  -- D1, D-012
  engagement_id  text REFERENCES company.engagements(id) ON DELETE CASCADE,
  title          text NOT NULL,
  question       text NOT NULL,
  why_owner      text,
  raised_by      text REFERENCES company.agents(slug) ON DELETE SET NULL,
  decider        text NOT NULL,                     -- 'CEO' | 'CTO'
  urgency        text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('blocking','normal')),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','decided','deferred')),
  options        jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommendation text,
  ruling         text,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- A "decided" row with no ruling is the exact failure mode this table exists
  -- to prevent: a gate that looks passed but records no reasoning.
  CONSTRAINT decided_has_ruling
    CHECK (status <> 'decided' OR (ruling IS NOT NULL AND decided_at IS NOT NULL))
);

-- ------------------------------------------------------------- evidence
CREATE TABLE IF NOT EXISTS company.evidence (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id      text NOT NULL REFERENCES company.tasks(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('screenshot','log','test_run','command','file','other')),
  location     text,                                -- path or URL; artifacts stay on disk
  summary      text,
  collected_by text REFERENCES company.agents(slug) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- indexes
CREATE INDEX IF NOT EXISTS messages_engagement_created_idx
  ON company.messages (engagement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_task_created_idx
  ON company.messages (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_to_agent_idx
  ON company.messages (to_agent, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_engagement_status_idx
  ON company.tasks (engagement_id, status);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx
  ON company.tasks (assignee) WHERE status IN ('todo','in_progress','in_qa');
CREATE INDEX IF NOT EXISTS status_events_entity_idx
  ON company.status_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sessions_engagement_idx
  ON company.sessions (engagement_id, started_at DESC);
CREATE INDEX IF NOT EXISTS decisions_status_idx
  ON company.decisions (status, urgency);
CREATE INDEX IF NOT EXISTS evidence_task_idx
  ON company.evidence (task_id, created_at DESC);

-- ------------------------------------------------------- updated_at glue
CREATE OR REPLACE FUNCTION company.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS engagements_touch ON company.engagements;
CREATE TRIGGER engagements_touch BEFORE UPDATE ON company.engagements
  FOR EACH ROW EXECUTE FUNCTION company.touch_updated_at();

DROP TRIGGER IF EXISTS tasks_touch ON company.tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON company.tasks
  FOR EACH ROW EXECUTE FUNCTION company.touch_updated_at();

INSERT INTO company.schema_migrations (version) VALUES ('001_init')
  ON CONFLICT (version) DO NOTHING;
