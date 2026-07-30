-- 016_goals.sql — company OBJECTIVES ("Mục tiêu"): the goal cards agents must finish,
-- each carrying a VIRTUAL revenue figure. Paired with the REAL LLM cost
-- (company.usage_costed) this drives the Mục tiêu tab's profit/loss view: is the work
-- the company does earning more (virtual revenue) than it costs (real tokens)?
-- Idempotent: table IF NOT EXISTS, seed rows ON CONFLICT DO NOTHING (owner edits win
-- thereafter — a re-run won't clobber). Revenue here is deliberately simulated.
CREATE TABLE IF NOT EXISTS company.goals (
  id           text PRIMARY KEY,                  -- G-1, G-2 …
  title        text NOT NULL,
  description  text,
  owner        text REFERENCES company.agents(slug) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('todo','in_progress','done','at_risk')),
  progress     int  NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  revenue_usd  numeric(12,2) NOT NULL DEFAULT 0,  -- virtual revenue this goal earns
  target_date  date,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_status_idx ON company.goals (status);

-- The goal ROWS are agent-dependent (owner → company.agents) and are seeded in
-- seed/deploy_post_build.sql, which runs AFTER build.py populates the roster. Keeping
-- them out of this migration is what lets a fresh deploy apply migrations before the
-- agents exist without tripping the owner FK.
