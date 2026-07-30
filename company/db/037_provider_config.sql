-- 037_provider_config.sql — per-provider request/model params: {maxOutput, maxContext,
-- temperature}. maxOutput (max_tokens) + temperature are applied on every call to this
-- provider; maxContext is informational (shown, not enforced). jsonb so more params can be
-- added later without a migration.
ALTER TABLE company.custom_providers ADD COLUMN IF NOT EXISTS config jsonb NOT NULL DEFAULT '{}'::jsonb;
