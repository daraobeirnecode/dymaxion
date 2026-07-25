-- Phase 2B: dedicated ArcGIS credential metadata and encrypted access-token envelopes.
-- This table is storage only. It intentionally provides no OAuth/browser
-- connection setup surface, no physical ArcGIS URLs, and no refresh/client secrets.

CREATE TABLE IF NOT EXISTS dymaxion.arcgis_credentials (
  credential_alias                  TEXT PRIMARY KEY,
  credential_identity               TEXT NOT NULL,
  portal_kind                       TEXT NOT NULL,
  permissions                       JSONB NOT NULL,
  encrypted_access_token_envelope   TEXT NOT NULL,
  token_type                        TEXT NOT NULL DEFAULT 'Bearer',
  expires_at                        TIMESTAMPTZ NOT NULL,
  connected_at                      TIMESTAMPTZ NOT NULL,
  refreshed_at                      TIMESTAMPTZ NOT NULL,
  connected_by_user                 TEXT NOT NULL,

  CONSTRAINT arcgis_credentials_alias_format
    CHECK (credential_alias ~ '^[a-z][a-z0-9-]{0,63}$'),
  CONSTRAINT arcgis_credentials_identity_format
    CHECK (credential_identity ~ '^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$'),
  CONSTRAINT arcgis_credentials_portal_kind_value
    CHECK (portal_kind IN ('arcgis-online', 'arcgis-enterprise')),
  CONSTRAINT arcgis_credentials_permissions_locked
    CHECK (permissions = '["feature:query"]'::jsonb),
  CONSTRAINT arcgis_credentials_envelope_bounds
    CHECK (
      length(encrypted_access_token_envelope) BETWEEN 48 AND 8192
      AND encrypted_access_token_envelope ~ '^[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,8064}$'
    ),
  CONSTRAINT arcgis_credentials_token_type_bearer
    CHECK (token_type = 'Bearer'),
  CONSTRAINT arcgis_credentials_timestamp_millisecond_precision
    CHECK (
      expires_at = date_trunc('milliseconds', expires_at)
      AND connected_at = date_trunc('milliseconds', connected_at)
      AND refreshed_at = date_trunc('milliseconds', refreshed_at)
    ),
  CONSTRAINT arcgis_credentials_expiry_after_connection
    CHECK (expires_at > connected_at),
  CONSTRAINT arcgis_credentials_refreshed_not_before_connected
    CHECK (refreshed_at >= connected_at),
  CONSTRAINT arcgis_credentials_connected_by_user_bounds
    CHECK (length(connected_by_user) BETWEEN 1 AND 256 AND connected_by_user !~ '[\r\n\x00]')
);
