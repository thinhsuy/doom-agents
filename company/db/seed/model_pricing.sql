-- model_pricing.sql — published Anthropic prices, $ per 1M tokens.
-- Verified 2026-06-24 via the claude-api skill (platform.claude.com/docs pricing).
-- Re-run to refresh; ON CONFLICT keeps this the source of truth.

INSERT INTO company.model_pricing
  (model, provider, input_per_mtok, output_per_mtok, cache_read_mult, cache_write_mult, note, source, effective_on) VALUES
  ('claude-opus-4-8',  'Anthropic', 5.00,  25.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-opus-4-7',  'Anthropic', 5.00,  25.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-sonnet-5',  'Anthropic', 3.00,  15.00, 0.1, 1.25, 'Intro $2/$10 per MTok through 2026-08-31', 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-haiku-4-5', 'Anthropic', 1.00,   5.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-fable-5',   'Anthropic', 10.00, 50.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24')
ON CONFLICT (model) DO UPDATE SET
  provider=EXCLUDED.provider, input_per_mtok=EXCLUDED.input_per_mtok,
  output_per_mtok=EXCLUDED.output_per_mtok, cache_read_mult=EXCLUDED.cache_read_mult,
  cache_write_mult=EXCLUDED.cache_write_mult, note=EXCLUDED.note,
  source=EXCLUDED.source, effective_on=EXCLUDED.effective_on, updated_at=now();
