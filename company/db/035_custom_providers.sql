-- 035_custom_providers.sql — owner-added LLM providers with an OpenAI-COMPATIBLE endpoint.
-- Any server that speaks the OpenAI chat.completions API works here: vLLM, Ollama, OpenRouter,
-- Together, HuggingFace TGI, LocalAI, etc. The backend calls them via the OpenAI SDK with the
-- configured base_url + api_key (api_key may be empty for a local no-auth endpoint). Models is
-- a list of {id,label}; agent_runtime.provider = this id, .model = a model id from the list.
CREATE TABLE IF NOT EXISTS company.custom_providers (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{1,39}$'),
  label      text NOT NULL,
  base_url   text NOT NULL,
  api_key    text,
  models     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
