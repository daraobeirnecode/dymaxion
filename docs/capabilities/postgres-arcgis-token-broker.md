# PostgreSQL ArcGIS token broker (Phase 2B)

## Status and security default

Phase 2B provides a production-shaped, read-only `PostgresArcGisTokenBroker` for
`query_secured_feature_service`. It reads strict ArcGIS credential metadata and
an encrypted access-token envelope from `dymaxion.arcgis_credentials` only after
the existing approval boundary allows the query.

The secure default is unchanged:

- `DYMAXION_ARCGIS_TOKEN_BROKER` unset: the unavailable broker is selected.
- `DYMAXION_ARCGIS_TOKEN_BROKER=postgres`: the PostgreSQL broker is selected.
- Any other value—including case changes, whitespace or an empty string—fails
  synchronously with a generic configuration error.
- `config/arcgis-targets.yaml` is committed with `targets: []`.

Selector validation runs before daemon or subcommand work. Smoke mode validates
configuration and local folders without constructing the broker, opening a
PostgreSQL pool or reading/decrypting credential rows.

## What Phase 2B does

For an approved `query_secured_feature_service` invocation, the runtime:

1. resolves a logical target slug from the strict target registry;
2. reads token-free credential metadata for the opaque alias;
3. binds approval to the canonical query, target configuration digest,
   operation, portal kind and broker-owned credential identity;
4. consumes the one-time approval at the shared execution sink;
5. re-resolves current target and credential facts;
6. reads the encrypted envelope, verifies the complete binding and expiry,
   decrypts it once, and sends `Bearer <token>` only in request headers.

Physical URLs, credential identity, encrypted envelopes and bearer material are
excluded from results, evidence, errors, recorder output, structured logs and
audit records. Boundary/audit surfaces use `arcgis-target://<slug>` identities.

## Deployment opt-in

Do not opt in until all prerequisites below have been independently reviewed for
the intended deployment.

1. Apply the idempotent migrations:

   ```bash
   bash scripts/apply-migrations.sh
   ```

   Migration `005_arcgis_credentials.sql` creates
   `dymaxion.arcgis_credentials` with strict alias, identity, portal-kind,
   permission, Bearer-token, envelope and timestamp constraints.

2. Add each approved target to `config/arcgis-targets.yaml`. Keep credentials,
   tokens and signed URLs out of this file. A target contains only its logical
   slug, portal kind, canonical portal/service/layer routes, allowed aliases and
   the single allowed `query` operation.

3. Provision a valid encrypted credential row through a trusted operator-owned
   process as described below. Phase 2B ships no supported insert/update command.

4. Supply the existing 64-hex-character `OAUTH_TOKEN_ENCRYPTION_KEY` to the
   runtime through the deployment secret manager. It must be the same key used
   to create the AES-256-GCM envelope. Never place this key or plaintext token in
   YAML, source control, command arguments, shell history, logs or documentation.

5. Set the runtime environment variable to the exact value:

   ```text
   DYMAXION_ARCGIS_TOKEN_BROKER=postgres
   ```

   For Docker Compose, inject that variable into the `dymaxion-runtime` service
   using a reviewed private Compose override or deployment manifest. Merely
   adding it to the repository `.env` does not forward an undeclared variable
   into the container.

6. Restart the runtime and verify configuration in a non-production environment
   before any approved authenticated query. Do not treat `smoke-test` as a
   credential or connectivity test: it intentionally performs neither.

Rollback is fail-closed: remove/unset `DYMAXION_ARCGIS_TOKEN_BROKER` and restart
the runtime. Existing encrypted rows remain inert and are not read by the
unavailable broker.

## Target-registry contract

`config/arcgis-targets.yaml` uses schema version `1.0.0`. Each row must bind:

- one canonical lowercase `target_slug`;
- `portal_kind`: `arcgis-online` or `arcgis-enterprise`;
- canonical HTTPS `portal_root`, `service_root` and exact
  `FeatureServer/<layer-id>` `layer_url`;
- one or more allowed logical credential aliases;
- `allowed_operations: [query]`.

The target registry never contains token material. ArcGIS Enterprise hosts also
need explicit employer-boundary allowlisting; deny rules still win.

## Credential-row and provisioning boundary

The PostgreSQL repository is read-only. Phase 2B deliberately does **not** ship:

- a CLI or SQL wrapper for inserting plaintext access tokens;
- an OAuth/browser connection flow;
- admin CRUD endpoints or dashboard controls;
- token refresh, rotation or revocation jobs;
- client-secret storage.

A deployment owner must design and separately review the provisioning path. That
path must encrypt the token before database insertion, avoid plaintext command
arguments/stdout/history, authenticate the operator, record provenance, and
write a row whose fields satisfy migration `005`:

| Field | Contract |
| --- | --- |
| `credential_alias` | Logical lowercase alias; must be allowed by the target. |
| `credential_identity` | Stable broker-owned account identity used in approval binding. |
| `portal_kind` | `arcgis-online` or `arcgis-enterprise`; must match the target. |
| `permissions` | Exactly `["feature:query"]`. |
| `encrypted_access_token_envelope` | AES-256-GCM envelope produced with the runtime encryption key; never plaintext. |
| `token_type` | Exactly `Bearer`. |
| `expires_at` | Millisecond-precision timestamp after connection time. |
| `connected_at`, `refreshed_at` | Millisecond-precision provenance timestamps. |
| `connected_by_user` | Authenticated operator identity, not agent-authored input. |

Enabling `postgres` without a valid matching target and row remains safe: the
query fails generically before transport.

## Expiry and failure behavior

Both metadata resolution and late secret materialization require `expires_at` to
be **strictly more than 60 seconds** after the current runtime time. Exact-margin,
inside-margin, expired or malformed timestamps fail closed. The late check is
repeated after approval consumption so a credential cannot cross the margin
between approval and dispatch.

Target digest, alias, credential identity, portal kind, permission, token type or
expiry drift fails before decrypt/transport whenever possible. Repository,
decryption and authorization-format failures collapse to fixed generic errors;
raw database, envelope, URL, identity, key-name and token values are not echoed.
There is no refresh fallback in Phase 2B.

## Validation status and deferred work

Phase 2B was validated only with synthetic credential records, an in-memory
repository seam, mocked DNS/ArcGIS transport, the real production broker class,
and the existing one-time approval implementation. Tests prove no secret lookup
or decrypt before approval consumption, one late lookup/decrypt on success,
zero unauthorized transport, and token/canary-free persisted surfaces.

No live authenticated ArcGIS Online or ArcGIS Enterprise endpoint, production
credential, private network, or live PostGIS database was accessed. A live pilot
remains deferred and requires explicit approval plus a separately reviewed
credential-provisioning procedure.

Deliberately deferred follow-on work:

- ArcGIS OAuth/browser connection and callback handling;
- refresh-token/client-secret storage and automatic refresh;
- operator-facing provisioning, rotation, revocation and status controls;
- admin UI/API support and audit UX;
- approved live pilot and operational runbook evidence.
