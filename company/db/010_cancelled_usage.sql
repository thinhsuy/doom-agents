-- 010_cancelled_usage.sql — (1) tasks can be CANCELLED (with a mandatory reason,
-- enforced at the tool layer); (2) pricing row for Claude Sonnet 4.5 so REAL
-- metered usage (recorded by the backend since the sample purge) prices correctly.

ALTER TABLE company.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE company.tasks ADD CONSTRAINT tasks_status_check CHECK (
  status = ANY (ARRAY['todo','in_progress','in_qa','rejected','accepted',
                      'deferred','escalated','cancelled'])
);

INSERT INTO company.model_pricing
  (model, provider, input_per_mtok, output_per_mtok, cache_read_mult, cache_write_mult, note, source, effective_on)
VALUES
  ('claude-sonnet-4-5', 'anthropic', 3.0, 15.0, 0.1, 1.25,
   'Sonnet-tier pricing ($3/$15/MTok) — the Bedrock sonnet alias runs claude-sonnet-4-5',
   'https://docs.claude.com/en/docs/about-claude/pricing', CURRENT_DATE)
ON CONFLICT (model) DO NOTHING;

INSERT INTO company.schema_migrations (version) VALUES ('010_cancelled_usage')
  ON CONFLICT (version) DO NOTHING;
