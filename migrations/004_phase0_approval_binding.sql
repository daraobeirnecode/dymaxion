-- Phase 0: bind approvals to immutable execution intent and one-time consumption.
-- Existing unbound rows are expired so they can never authorize execution.

ALTER TABLE dymaxion.approval_requests
  ADD COLUMN IF NOT EXISTS payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS target TEXT,
  ADD COLUMN IF NOT EXISTS credential_identity TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

UPDATE dymaxion.approval_requests
SET payload_hash = COALESCE(payload_hash, repeat('0', 64)),
    target = COALESCE(target, 'historical-unbound'),
    expires_at = COALESCE(expires_at, requested_at),
    decision = COALESCE(decision, 'expired'),
    decided_by = COALESCE(decided_by, 'phase-0-migration'),
    responded_at = COALESCE(responded_at, now())
WHERE payload_hash IS NULL OR target IS NULL OR expires_at IS NULL;

ALTER TABLE dymaxion.approval_requests
  ALTER COLUMN payload_hash SET NOT NULL,
  ALTER COLUMN target SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL;

ALTER TABLE dymaxion.approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_payload_hash_format,
  ADD CONSTRAINT approval_requests_payload_hash_format
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  DROP CONSTRAINT IF EXISTS approval_requests_decision_value,
  ADD CONSTRAINT approval_requests_decision_value
    CHECK (decision IS NULL OR decision IN ('approved', 'rejected', 'expired'));

CREATE INDEX IF NOT EXISTS approval_requests_pending_idx
  ON dymaxion.approval_requests (expires_at)
  WHERE decision IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_consumed_once_idx
  ON dymaxion.approval_requests (id)
  WHERE consumed_at IS NOT NULL;
