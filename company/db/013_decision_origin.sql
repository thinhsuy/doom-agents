-- 013_decision_origin.sql — remember which chat group a decision was raised from, so
-- when the CEO/CTO submits a ruling we can trigger the raising agent to continue IN
-- that same group (with full context). Idempotent. Existing rows stay NULL → the
-- decide endpoint falls back to the open company channel.
ALTER TABLE company.decisions ADD COLUMN IF NOT EXISTS origin_channel text;
