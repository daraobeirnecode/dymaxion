# Phase 2B PostgreSQL ArcGIS Token Broker Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task. The controller owns the final release commit; implementation/review subagents must not stage, commit, push, or access live ArcGIS services.

**Goal:** Add an opt-in PostgreSQL-backed ArcGIS token broker that keeps encrypted token material behind Dymaxion's existing approval boundary and prove it with synthetic end-to-end tests.

**Architecture:** Store ArcGIS credential metadata and encrypted access-token envelopes in a dedicated `dymaxion.arcgis_credentials` table rather than overloading LLM-provider OAuth rows. Split metadata lookup from secret-envelope lookup so `describe()` cannot read or decrypt token material. Enable the production broker only with the exact runtime selector `DYMAXION_ARCGIS_TOKEN_BROKER=postgres`; the existing unavailable broker remains the default.

**Tech Stack:** TypeScript 5.8, Node.js 22.23.1, Zod, Drizzle ORM, PostgreSQL 18, AES-256-GCM, Node test runner through `tsx`.

## Locked scope and bypass risks

- This slice uses **synthetic credentials and mocked ArcGIS transport only**. It must not access a live private ArcGIS Online, Enterprise or PostGIS service.
- It adds no OAuth browser flow, refresh-token grant, admin connection UI, credential CLI or authenticated write operation.
- No token, encryption key, private URL or credential identity may enter Git, YAML, command arguments, logs, errors, outputs, evidence or boundary audits.
- `describe(alias)` may read only non-secret metadata and must not fetch/decrypt the token envelope.
- Late authorization is called only after approval consumption with the approved `credential_identity`, target configuration digest, portal kind and `feature:query` permission. It must re-resolve the trusted target, require the current metadata/secret row to match every approved fact, fetch/decrypt once, reject tokens expiring in 60 seconds or less, and return only bounded Bearer header material.
- Default runtime behavior remains fail-closed. Unknown broker selector values fail startup/configuration rather than silently falling back.
- Existing LLM OAuth token behavior and encryption-envelope compatibility must remain unchanged.
- Phase completion is **technical broker readiness only**, not a live-value or deployment claim.

---

### Task 1: Add the dedicated credential persistence contract

**Objective:** Define strict PostgreSQL storage and runtime row contracts without exposing a provisioning surface.

**Files:**
- Create: `migrations/005_arcgis_credentials.sql`
- Modify: `dymaxion-runtime/src/db/schema.ts`
- Create: `dymaxion-runtime/src/security/arcgis-token-records.ts`
- Test: `dymaxion-runtime/test/postgres-arcgis-token-broker.test.ts`

**Steps:**
1. Write failing schema/record tests for strict metadata and secret-envelope rows, duplicate/unknown fields, logical aliases, portal kind, permissions, expiry, and bounded encrypted envelopes.
2. Run the focused test with Node `22.23.1` and verify the expected failure.
3. Add `dymaxion.arcgis_credentials` with alias primary key, logical credential identity, portal kind, permissions JSONB, encrypted access-token envelope, exact Bearer type, non-null expiry, connection/refreshed timestamps and bounded operator identity. `connected_at` and `refreshed_at` must be supplied explicitly and must not have database or Drizzle defaults. Define these named SQL constraints exactly:
   - `arcgis_credentials_alias_format`: `credential_alias ~ '^[a-z][a-z0-9-]{0,63}$'`.
   - `arcgis_credentials_identity_format`: `credential_identity ~ '^[A-Za-z0-9][A-Za-z0-9:._/@-]{2,255}$'`.
   - `arcgis_credentials_portal_kind_value`: `portal_kind IN ('arcgis-online', 'arcgis-enterprise')`.
   - `arcgis_credentials_permissions_locked`: `permissions = '["feature:query"]'::jsonb`, which is stricter than the general descriptor ceiling and is the only Phase 2B permission.
   - `arcgis_credentials_envelope_bounds`: character length from 48 through 8192 inclusive plus the three-segment base64 envelope pattern `^[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,64}\.[A-Za-z0-9+/=]{16,8064}$`.
   - `arcgis_credentials_token_type_bearer`: `token_type = 'Bearer'`.
   - `arcgis_credentials_expiry_after_connection`: `expires_at > connected_at`.
   - `arcgis_credentials_refreshed_not_before_connected`: `refreshed_at >= connected_at` because both columns are non-null in this table.
   - `arcgis_credentials_timestamp_millisecond_precision`: `expires_at`, `connected_at` and `refreshed_at` must each equal `date_trunc('milliseconds', <column>)`, matching the runtime's exact three-fractional-digit ISO contract and preventing PostgreSQL/JavaScript ordering drift.
   - `arcgis_credentials_connected_by_user_bounds`: character length from 1 through 256 inclusive and no CR, LF or NUL.
   Do not add portal/service URLs, plaintext token columns, refresh token, client ID/secret or provisioning fields.
4. Add strict Zod row schemas and immutable runtime types.
5. Rerun focused tests and typecheck.

### Task 2: Implement metadata/secret separation and the PostgreSQL broker

**Objective:** Implement late secret access with dependency-injected repository and decryptor seams.

**Files:**
- Create: `dymaxion-runtime/src/security/postgres-arcgis-token-broker.ts`
- Modify: `dymaxion-runtime/src/security/arcgis-connections.ts`
- Test: `dymaxion-runtime/test/postgres-arcgis-token-broker.test.ts`

**Steps:**
1. Add failing tests proving `describe()` calls metadata lookup only and returns the existing `ArcGisCredentialDescriptor` shape. The Drizzle implementation must use an explicit non-secret column projection; it may not select a whole credential row and discard the envelope afterward.
2. Add failing tests proving late authorization receives the approved credential identity, target configuration digest, portal kind and permission; re-resolves the target; constrains secret lookup by alias plus expected identity; fetches/decrypts once; and fails closed for missing, malformed, permission/portal/digest/identity drift or unsupported token type.
3. Define one `ARCGIS_TOKEN_EXPIRY_MARGIN_MS = 60_000` constant used by descriptor and secret-materialization checks. Test expired, `now + margin - 1 ms`, exactly at the margin, and safely beyond it.
4. Implement `ArcGisCredentialRepository` with separate `findDescriptor()` and `findSecretEnvelope(alias, expectedCredentialIdentity)` methods plus a Drizzle implementation. Implement `PostgresArcGisTokenBroker` using injected registry, repository, decryptor and clock; broker/repository/decryptor errors must be generic and must not echo sensitive material.
5. Extend the capability/broker contract minimally so the post-consumption call carries the approved facts. Add drift tests that mutate identity or target configuration between approval consumption and secret lookup and assert zero decrypt and zero transport.
6. Rerun focused tests and typecheck.

### Task 3: Add explicit fail-closed runtime wiring

**Objective:** Make the broker usable in deployment without changing the secure default.

**Files:**
- Modify: `dymaxion-runtime/src/security/arcgis-connections.ts`
- Modify: `dymaxion-runtime/src/main.ts` only if startup registration is required
- Test: `dymaxion-runtime/test/postgres-arcgis-token-broker.test.ts`

**Steps:**
1. Write failing tests for selector absent, exact `postgres`, and unknown/whitespace/case variants.
2. Add a dedicated fail-closed selector module with type-only imports and lazy construction. It returns the unavailable broker by default and constructs the PostgreSQL broker only for exact `postgres`; do not import the eager database client into schema/config modules.
3. Route production broker resolution consistently through that module for normal, replay and direct runtime execution. Smoke mode may validate the selector without connecting to PostgreSQL. Broker construction must not read/decrypt rows or trigger network access.
4. Prove unknown, whitespace and case variants fail before recorder, transport, database secret lookup or decryptor access.
5. Rerun focused tests and typecheck.

### Task 4: Prove the approval-to-query integration and document the contract

**Objective:** Exercise the production-shaped broker through the existing secured-query approval boundary using synthetic records and transport.

**Files:**
- Modify: `dymaxion-runtime/test/query-secured-feature-service.test.ts`
- Modify: `README.md`
- Modify: `dymaxion-runtime/README.md`
- Modify: `CLAUDE.md`
- Create: `docs/capabilities/postgres-arcgis-token-broker.md`

**Steps:**
1. Add a synthetic approved-read integration test that uses `PostgresArcGisTokenBroker`, an in-memory repository seam and mocked transport.
2. Assert no secret lookup/decryption before approval consumption; assert one late lookup/decryption afterward; assert token-free result, evidence, errors, recorder, structured logger and audit surfaces.
3. Add identity/config drift, expiry-boundary, repository/decryptor-error and logger canaries; prove zero unauthorized decrypt/transport and no canary serialization.
4. Document opt-in configuration, migration, provisioning boundary, no-live-pilot status, expiry behavior and deliberately deferred OAuth/refresh/admin work.
5. Rerun focused secured-query and broker tests.

### Task 5: Freeze and verify the Phase 2B candidate

**Objective:** Produce a reviewed local candidate without publishing it.

**Files:**
- Review all changed and nonignored untracked files from base `ba55de7f9b9e544f4383f5b21fffbecea1792a3e`.

**Steps:**
1. Run Node `22.23.1` focused tests, full test suite, typecheck, production build, GISBench, production/full dependency audits, runtime capability smoke, migration/schema consistency, `git diff --check`, and source-integrity/secret scans.
2. Obtain independent stable-tree spec and security/code-quality reviews; remediate with permanent regressions and rerun affected gates.
3. Stage only intended paths, scan exact index blobs, record candidate tree, create one controller-owned commit, and verify committed tree identity.
4. Obtain an independent exact-SHA review against base `ba55de7f9b9e544f4383f5b21fffbecea1792a3e`.
5. Stop before public push/PR. Request explicit publication approval with exact SHA, review verdict, gates and residual limits. Record that live authenticated ArcGIS validation remains deferred.
