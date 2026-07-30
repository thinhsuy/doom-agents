-- 038_investment_events.sql — Action History for the Investment tab. Records who
-- declared / updated / sold / deleted which position so the owner sees an audit trail.
-- No FK on investment_id: a 'delete' event must survive after the investment row is gone,
-- and the symbol is snapshotted for the same reason.
CREATE TABLE IF NOT EXISTS company.investment_events (
  id            bigserial PRIMARY KEY,
  investment_id text,
  action        text NOT NULL CHECK (action IN ('create','update','sell','delete')),
  actor         text,        -- owner username (ceo/cto/coo/cio); NULL if unknown
  symbol        text,        -- snapshot so the row still reads after the position is deleted
  summary       text,        -- human-readable description of what happened
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS investment_events_time_idx ON company.investment_events (id DESC);
