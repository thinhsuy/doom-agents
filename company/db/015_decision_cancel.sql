-- 015_decision_cancel.sql — let the CEO/CTO CANCEL a pending decision (drop it instead
-- of ruling on it), optionally with a note. Adds 'cancelled' to the status CHECK.
-- Idempotent: finds the enum CHECK by its unique 'pending' literal (Postgres rewrites
-- `IN (...)` to `= ANY (ARRAY[...])`, so we can't match on "IN"), drops it, re-adds a
-- named one that includes 'cancelled'. Re-running is a harmless no-op.
DO $$
DECLARE cn text;
BEGIN
  SELECT conname INTO cn
  FROM pg_constraint
  WHERE conrelid = 'company.decisions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%pending%';
  IF cn IS NOT NULL THEN
    EXECUTE format('ALTER TABLE company.decisions DROP CONSTRAINT %I', cn);
  END IF;
END $$;

ALTER TABLE company.decisions
  ADD CONSTRAINT decisions_status_check
  CHECK (status IN ('pending','decided','deferred','cancelled'));
