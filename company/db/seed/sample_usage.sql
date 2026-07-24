-- sample_usage.sql — DEMO metering for the Monitor tab, tied to sample ENG-001.
-- is_sample=true; cost is computed from REAL model_pricing, so the methodology is
-- genuine even though the token counts are illustrative.
-- Remove with:  DELETE FROM company.usage_events WHERE is_sample;
BEGIN;
INSERT INTO company.usage_events
  (agent, engagement_id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, is_sample) VALUES
  -- Engagement Director: intake + escalation (Opus)
  ('engagement-director','ENG-001',NULL,'claude-opus-4-8',  8200, 1300,     0,  6400, true),
  ('engagement-director','ENG-001','T-104','claude-opus-4-8', 5100,  700, 12000,     0, true),
  -- Business Analyst: spec authoring, heavy (Opus)
  ('product-business-analyst','ENG-001',NULL,'claude-opus-4-8', 12400, 3800,  8000, 9200, true),
  ('product-business-analyst','ENG-001',NULL,'claude-opus-4-8',  9100, 2100, 15000,    0, true),
  -- Product Owner: spec + acceptance verdicts (Opus)
  ('product-owner','ENG-001',NULL,'claude-opus-4-8', 10300,  950, 12500,     0, true),
  ('product-owner','ENG-001','T-102','claude-opus-4-8',  9800, 1100, 14000,     0, true),
  -- Senior PM: backlog decomposition (Sonnet — cheaper role)
  ('project-manager-senior','ENG-001',NULL,'claude-sonnet-5', 6400, 1600, 4200, 3000, true),
  -- Backend Architect: the build workhorse (Opus, several tasks)
  ('engineering-backend-architect','ENG-001','T-101','claude-opus-4-8', 22000, 6400, 31000, 16000, true),
  ('engineering-backend-architect','ENG-001','T-102','claude-opus-4-8', 24500, 7100, 38000, 12000, true),
  ('engineering-backend-architect','ENG-001','T-105','claude-opus-4-8', 19800, 5200, 41000,     0, true),
  -- Frontend Developer: screens (Opus)
  ('engineering-frontend-developer','ENG-001','T-103','claude-opus-4-8', 16200, 4600, 21000, 10500, true),
  -- Evidence Collector: QA verification (Sonnet)
  ('testing-evidence-collector','ENG-001','T-102','claude-sonnet-5', 9400, 1250, 6000, 4800, true),
  ('testing-evidence-collector','ENG-001','T-105','claude-sonnet-5', 8900, 1400, 7200,    0, true);
COMMIT;
