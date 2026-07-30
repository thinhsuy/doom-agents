-- 025_deploy_seed.sql — fixed reference data that a bare migration run would otherwise miss,
-- so a fresh deploy matches the current local baseline. Idempotent (ON CONFLICT DO NOTHING).
--
-- NOT here (by design):
--   • The AGENT ROSTER (company.agents / runtime / permissions) is DERIVED from the repo's
--     .md files by build.py (`npm run data`) — run it after these migrations.
--   • Agent-DEPENDENT standing channels (leadership / HR) live in seed/standing_channels.sql,
--     run AFTER build.py so their membership FKs resolve.
--   • Owner accounts (019), permission catalog (017), infra pricing (023/024) and goals (016)
--     are already seeded by their own migrations.

-- Model prices ($/1M tokens) — powers the Monitor cost meter + Goals P&L. The full set
-- (the incremental migrations only seeded a subset).
INSERT INTO company.model_pricing
  (model, provider, input_per_mtok, output_per_mtok, cache_read_mult, cache_write_mult, note, source, effective_on) VALUES
  ('gpt-4o-mini',       'openai',    0.15,  0.60, 0.1, 1.25, 'OpenAI GPT-4o mini', 'https://openai.com/api/pricing', '2026-06-24'),
  ('gpt-4o',            'openai',    2.50, 10.00, 0.1, 1.25, 'OpenAI GPT-4o', 'https://openai.com/api/pricing', '2026-06-24'),
  ('claude-haiku-4-5',  'Anthropic', 1.00,  5.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-sonnet-4-5', 'anthropic', 3.00, 15.00, 0.1, 1.25, 'Sonnet-tier pricing ($3/$15/MTok) — the Bedrock sonnet alias runs claude-sonnet-4-5', 'https://docs.claude.com/en/docs/about-claude/pricing', '2026-06-24'),
  ('claude-sonnet-5',   'Anthropic', 3.00, 15.00, 0.1, 1.25, 'Intro $2/$10 per MTok through 2026-08-31', 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-opus-4-8',   'Anthropic', 5.00, 25.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-opus-4-7',   'Anthropic', 5.00, 25.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24'),
  ('claude-fable-5',    'Anthropic', 10.00, 50.00, 0.1, 1.25, NULL, 'Anthropic docs (claude-api skill, cached 2026-06-24)', '2026-06-24')
ON CONFLICT (model) DO NOTHING;

-- Standing engagement that chat-created tasks belong to (mirrors _ensure_ops_engagement).
INSERT INTO company.engagements (id, title, request_verbatim, mode, status) VALUES
  ('ENG-OPS', 'Giao việc trực tiếp (Ban lãnh đạo)',
   'Task do lead tạo từ chỉ đạo của CEO/CTO trong Team Chat', 'micro', 'build')
ON CONFLICT (id) DO NOTHING;

-- Company-wide OPEN channel (no member list = visible to all owners; any hired agent is @-taggable).
INSERT INTO company.channels (id, name, topic, kind) VALUES
  ('ch-general', 'Toàn công ty',
   'Kênh chung toàn công ty — tag (@) bất kỳ agent biên chế nào để hỏi/giao việc', 'topic')
ON CONFLICT (id) DO NOTHING;
