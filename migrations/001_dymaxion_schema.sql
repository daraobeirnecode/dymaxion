-- Dymaxion core schema (dymaxion.*)
-- Applied automatically on first boot via /docker-entrypoint-initdb.d/,
-- or manually via scripts/apply-migrations.sh (idempotent).

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AGE (graph) is optional — not bundled in the pgvector image. Load it if
-- present; skip with a notice otherwise so first boot never fails.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS age;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'AGE extension not available in this image — graph features disabled (%).', SQLERRM;
END $$;

CREATE SCHEMA IF NOT EXISTS dymaxion;

-- projects (per-client, per-engagement) — created first: messages FKs to it
CREATE TABLE IF NOT EXISTS dymaxion.projects (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  client            TEXT,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | archived
  context           JSONB NOT NULL DEFAULT '{}',      -- CRS, portal URL, schema, key datasets, knowledge_domains, ...
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

-- conversations (also holds knowledge-base seed chunks: gateway='system-seed')
CREATE TABLE IF NOT EXISTS dymaxion.messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway           TEXT NOT NULL,                    -- telegram | teams | email | cli | web | system-seed | ...
  source_id         TEXT NOT NULL,                    -- chat_id, thread_id, email address, ...
  direction         TEXT NOT NULL,                    -- inbound | outbound | reference
  body              TEXT NOT NULL,
  attachments       JSONB,                            -- file paths, URLs, topic_tags for seeds
  intent            TEXT,                             -- classified intent
  embedding         vector(1024),                     -- voyage-3-large
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  project_id        UUID REFERENCES dymaxion.projects(id),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_source ON dymaxion.messages(gateway, source_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_embedding ON dymaxion.messages USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_messages_project ON dymaxion.messages(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_body_trgm ON dymaxion.messages USING gin (body gin_trgm_ops);

-- preferences (user-level, single row per key)
CREATE TABLE IF NOT EXISTS dymaxion.preferences (
  key               TEXT PRIMARY KEY,
  value             JSONB NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- named datasets
CREATE TABLE IF NOT EXISTS dymaxion.datasets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT UNIQUE NOT NULL,
  source_type       TEXT NOT NULL,                    -- feature_service | postgis | shapefile | geopackage | stac | ...
  source_uri        TEXT NOT NULL,
  schema_json       JSONB,
  spatial_reference INT,
  last_updated      TIMESTAMPTZ,
  project_ids       UUID[] DEFAULT ARRAY[]::UUID[],
  notes             TEXT,
  deleted_at        TIMESTAMPTZ
);

-- agent runs (one per user request)
CREATE TABLE IF NOT EXISTS dymaxion.agent_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID REFERENCES dymaxion.messages(id),
  project_id        UUID REFERENCES dymaxion.projects(id),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'running',  -- running | completed | failed | awaiting_approval
  plan              JSONB NOT NULL,
  final_narrative   TEXT,
  cost_usd          NUMERIC(10, 4) DEFAULT 0,
  langfuse_trace_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_started ON dymaxion.agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON dymaxion.agent_runs(status);

-- skill invocations (many per agent run)
CREATE TABLE IF NOT EXISTS dymaxion.skill_invocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id      UUID NOT NULL REFERENCES dymaxion.agent_runs(id),
  skill_slug        TEXT NOT NULL,
  skill_version     TEXT NOT NULL,
  invoked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  input             JSONB NOT NULL,
  output            JSONB,
  error             JSONB,
  cost_usd          NUMERIC(10, 4) DEFAULT 0,
  llm_calls_count   INT DEFAULT 0,
  tool_calls_count  INT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_skill_invocations_run ON dymaxion.skill_invocations(agent_run_id);
CREATE INDEX IF NOT EXISTS idx_skill_invocations_skill ON dymaxion.skill_invocations(skill_slug, invoked_at DESC);

-- skill history (aggregate stats for skill selection)
CREATE TABLE IF NOT EXISTS dymaxion.skill_history (
  skill_slug        TEXT PRIMARY KEY,
  total_invocations INT DEFAULT 0,
  success_count     INT DEFAULT 0,
  failure_count     INT DEFAULT 0,
  avg_duration_ms   NUMERIC,
  avg_cost_usd      NUMERIC(10, 4),
  last_invoked_at   TIMESTAMPTZ
);

-- skill registry (filesystem catalog mirrored into the DB at registration)
CREATE TABLE IF NOT EXISTS dymaxion.skill_registry (
  slug              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  version           TEXT NOT NULL,
  category          TEXT NOT NULL,                    -- esri | oss | web-mobile | architecture | meta
  skill_class       TEXT NOT NULL,
  destructive       BOOLEAN NOT NULL DEFAULT false,
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  authored_by       TEXT NOT NULL,
  manifest          JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',   -- active | archived
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  embedding         vector(1024)                      -- for similar-skill search during self-authoring
);

-- proposed skills (waiting for human approval)
CREATE TABLE IF NOT EXISTS dymaxion.proposed_skills (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL,
  proposed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  proposed_for_run  UUID REFERENCES dymaxion.agent_runs(id),
  skill_md          TEXT NOT NULL,                    -- full SKILL.md content
  manifest_yaml     TEXT NOT NULL,
  scripts           JSONB NOT NULL,                   -- {filename: contents}
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_at       TIMESTAMPTZ,
  review_notes      TEXT
);

-- approval requests (human-in-the-loop for destructive ops)
CREATE TABLE IF NOT EXISTS dymaxion.approval_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id      UUID NOT NULL REFERENCES dymaxion.agent_runs(id),
  step_description  TEXT NOT NULL,
  step_payload      JSONB NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at      TIMESTAMPTZ,
  decision          TEXT,                             -- approved | rejected | expired
  decided_by        TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_pending
  ON dymaxion.approval_requests(requested_at DESC) WHERE decision IS NULL;

-- budget ledger (monthly per-tier spend, enforced pre-call)
CREATE TABLE IF NOT EXISTS dymaxion.budget_ledger (
  tier              TEXT NOT NULL,
  month             DATE NOT NULL,                    -- first of month
  spent_usd         NUMERIC(10, 4) NOT NULL DEFAULT 0,
  frozen            BOOLEAN NOT NULL DEFAULT false,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tier, month)
);

-- audit log (append-only, never deleted)
CREATE TABLE IF NOT EXISTS dymaxion.audit_log (
  id                BIGSERIAL PRIMARY KEY,
  event_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type        TEXT NOT NULL,                    -- llm_call | tool_call | file_write | data_query | boundary_block | approval | ...
  payload           JSONB NOT NULL,
  agent_run_id      UUID REFERENCES dymaxion.agent_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event ON dymaxion.audit_log(event_type, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_run ON dymaxion.audit_log(agent_run_id);
