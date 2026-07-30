-- 036_provider_protocol.sql — which API PROTOCOL a custom provider speaks (which SDK the
-- backend uses to call it). openai-chat / openai-responses go through the OpenAI SDK;
-- anthropic-messages / google-gemini are declared here and get their own SDK routing when
-- a real endpoint is configured. Existing providers default to OpenAI Chat Completions.
ALTER TABLE company.custom_providers ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT 'openai-chat'
  CHECK (protocol IN ('openai-chat', 'openai-responses', 'anthropic-messages', 'google-gemini'));
