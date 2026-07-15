-- OAuth token storage for OpenAI / Google / Azure / Cohere providers.
-- access_token + refresh_token are encrypted at rest (AES-256-GCM with
-- OAUTH_TOKEN_ENCRYPTION_KEY) by src/llm/token-store.ts before insert.
-- Decryption happens in-memory on every LLM call. Never logged, never traced.

CREATE TABLE IF NOT EXISTS dymaxion.oauth_tokens (
  provider              TEXT PRIMARY KEY,          -- 'openai' | 'google' | 'azure' | 'cohere'
  access_token          TEXT NOT NULL,             -- encrypted
  refresh_token         TEXT,                      -- encrypted
  token_type            TEXT NOT NULL DEFAULT 'Bearer',
  scope                 TEXT,
  expires_at            TIMESTAMPTZ,
  refreshed_at          TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_by_user     TEXT NOT NULL              -- operator identity (Tailscale header)
);

-- PKCE state for in-flight OAuth flows (created at authorize, consumed at callback)
CREATE TABLE IF NOT EXISTS dymaxion.oauth_flow_state (
  state                 TEXT PRIMARY KEY,
  provider              TEXT NOT NULL,
  code_verifier         TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
