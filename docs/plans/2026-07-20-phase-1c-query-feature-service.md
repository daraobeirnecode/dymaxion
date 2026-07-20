# Phase 1C Safe Feature Service Query Implementation Plan

> **For Fable 5:** implement this plan in the current isolated branch. Use test-driven changes, keep one coherent local branch, and do not commit, publish, deploy, or access live ArcGIS systems.

**Goal:** Add a native, deterministic, read-only `query_feature_service` capability that safely retrieves a bounded, schema-validated set of records from one approved ArcGIS FeatureServer layer with complete object-ID paging, truthful truncation, stable output and reproducible evidence.

**Architecture:** Reuse the Phase 1A/1B boundary checks, ArcGIS JSON validation, cancellation, redaction and evidence contracts. Extend the shared injectable ArcGIS transport non-breakingly with bounded POST-form support for `/query`; metadata remains GET. Query metadata and IDs first, canonicalize object IDs before any record ceiling selects survivors, then fetch explicit object-ID batches. Handle `exceededTransferLimit` by deterministic adaptive batch splitting. Never place `where`, object IDs or geometry payloads in evidence URLs; record HTTP method and a canonical request-body hash instead.

**Tech stack:** TypeScript 5.8, Node.js 22+, Zod, native capability registry, injectable synthetic ArcGIS transport, Node test runner and GISBench.

---

## MVP boundary

This slice supports one anonymous/public ArcGIS FeatureServer layer and returns Esri JSON attributes with optional geometry.

In scope:

- layer metadata/capability inspection before query;
- explicit requested `out_fields`, validated against metadata;
- metadata-derived object-ID field automatically included in the effective query fields;
- `returnIdsOnly` discovery followed by canonical object-ID batch paging;
- deterministic adaptive splitting when a feature page reports `exceededTransferLimit`;
- optional geometry and numeric `out_sr`;
- strict request, response-byte, total-byte, record and duration ceilings;
- cancellation before and after asynchronous boundary preflight and before every dispatch;
- versioned report/evidence with request body hashes and no query values in request URLs.

Explicitly out of scope and rejected by the strict input schema:

- statistics/group-by/order-by;
- geometry filters and datum transformations;
- attachments and related records;
- MapServer/ImageServer layers;
- authentication or credential inputs;
- edits, exports, sync, publication or any write.

These are later slices. Do not add speculative switches or partial implementations.

## Contract

### Input

Strict/versioned input:

- `layer_url`: HTTPS URL ending exactly in `/FeatureServer/<non-negative-layer-id>`; no query, fragment, userinfo, traversal, backslash, encoded segment or credential material;
- `where`: optional ArcGIS SQL predicate, default `1=1`, bounded to 2,048 characters, no control/NUL characters or credential material; document that it is included in canonical parameter evidence;
- `out_fields`: 1–100 unique explicit field names matching ArcGIS field-name syntax; reject `*` and duplicates case-insensitively;
- `return_geometry`: optional boolean, default false;
- `out_sr`: optional positive integer WKID, accepted only when `return_geometry` is true;
- `page_size`: optional positive integer, maximum 2,000; effective size is capped by valid service `maxRecordCount`;
- `max_records`: optional positive integer, default 1,000, hard ceiling 10,000;
- `max_requests`: optional positive integer, default 100, hard ceiling 200;
- `max_response_bytes`: optional per-response ceiling, 1 KiB–2 MiB;
- `max_total_response_bytes`: optional whole-run ceiling, 1 KiB–16 MiB;
- `max_duration_ms`: optional whole-run ceiling, 1–30 seconds.

The schema is strict. Token/key/password/cookie/auth fields and unsupported future query modes must fail validation.

### Metadata requirements

The metadata response must be a supported queryable Feature Layer or Table with:

- `capabilities` containing `Query`;
- one unambiguous object-ID field from `objectIdField` or exactly one `fields[].type === "esriFieldTypeOID"`;
- a valid unique fields array;
- a positive usable `maxRecordCount` or a bounded documented fallback;
- geometry type/spatial-reference summary when present.

Validate requested fields case-insensitively and emit canonical metadata names. Reject credential-like requested or metadata field names rather than returning likely secrets. Treat all metadata and ArcGIS error text as untrusted and redact before serialization.

### Retrieval behavior

1. GET the exact approved layer URL with `f=json` using the shared bounded ArcGIS request path.
2. POST to exact `<layer_url>/query` with `where`, `returnIdsOnly=true`, `returnGeometry=false`, `f=json`.
3. Validate a finite safe-integer object-ID array, reject duplicates, sort ascending before applying `max_records`, and expose `total_matched`, selected count and truthful truncation.
4. POST selected IDs in deterministic batches with explicit effective `outFields`, `returnGeometry`, optional `outSR`, and `f=json`.
5. If `exceededTransferLimit === true`, split that requested ID batch into deterministic halves and retry. A singleton that still exceeds the limit fails closed. Every attempt counts toward request/byte/duration ceilings and evidence.
6. Every returned feature must be an object with attributes containing exactly one safe-integer object ID from the requested batch. Reject duplicate, missing or unrequested IDs and a non-exceeded page that omits requested IDs.
7. Sort final features by object ID. Canonicalize metadata, warnings, caveats and truncation reasons before report/output hashing while retaining request evidence in actual dispatch order.

### Output

Strict/versioned output includes:

- canonical service summary: sanitized URL, layer ID, name, type, geometry type, object-ID field, source/output spatial reference, max record count, requested and effective fields;
- canonical query parameters and limits;
- `features`: object-ID-sorted records with explicit attributes and optional Esri JSON geometry;
- totals: matched IDs, selected IDs, returned records, requests and bytes;
- truncation state/reasons;
- deterministic warnings and exact support caveats;
- versioned evidence: canonical parameter hash, request records including `method` and canonical `request_sha256` for POST forms, source hash and canonical report hash.

Do not serialize raw form bodies, tokens, cookies or headers. Recursively redact credential-shaped material from remote strings that are allowed into metadata, attributes, warnings or errors.

## Security and correctness invariants

- Preserve ADR-0001 and all Phase 0 approval, identity, boundary and Worker behavior.
- Manifest classification is `read`; no write credential provider or approval is used.
- Executor preflight and every metadata/IDs/page request enforce the same boundary immediately before dispatch.
- Re-check cancellation after asynchronous DNS/audit boundary work and immediately before transport dispatch; abort during preflight means zero dispatches.
- Production transport uses POST form bodies for queries, `redirect: manual`, bounded streaming, timeout/abort signals, and JSON-only response handling.
- Query endpoint is derived only by appending `/query` to the validated layer URL. No remote-returned URL is ever dispatched.
- Evidence URLs contain no query string. POST form hashes are canonical and reproducible but bodies are not serialized.
- Received bytes count exactly once on success and typed HTTP/error failures. Every dispatch attempt counts against request ceilings.
- Object-ID order and feature response order cannot alter selected records, report order or canonical output hash.
- Fixture transports exact-match method, URL and canonical form fields and fail closed on any unexpected request.
- All tests are synthetic, fixture-backed, anonymous and use stubbed DNS. No live ArcGIS, Sacramento, employer, private or authenticated service may be queried.

## Task 1: Contracts and red tests

**Files:**

- Create: `dymaxion-runtime/src/capabilities/query-feature-service.ts`
- Create: `dymaxion-runtime/test/query-feature-service.test.ts`
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify: `dymaxion-runtime/src/contracts/evidence.ts` only for optional method/request-body hash evidence fields.

Write failing tests for strict input/output schemas, manifest truth, registry inclusion, URL validation, unsupported inputs, credential rejection, metadata validation and evidence schema compatibility. Preserve existing capability outputs.

## Task 2: Bounded POST-form ArcGIS transport

**Files:**

- Modify: `dymaxion-runtime/src/capabilities/arcgis-rest.ts`
- Modify existing ArcGIS tests where needed without weakening GET assertions.

Add non-breaking injectable POST-form transport support and a shared bounded JSON request path that selects GET or POST. Canonicalize form entries before hashing. Boundary-check and cancellation-check immediately before dispatch. Keep request evidence backward-compatible while allowing `method` and `request_sha256`.

Test redirect rejection, HTTP-200 ArcGIS error envelopes, content types, streamed/per-response bytes, total accounting at the capability level, cancellation during preflight, lookalike/private DNS blocks and absence of form values from evidence URLs/errors.

## Task 3: Deterministic query engine

Implement metadata → IDs → canonical batch retrieval. Add tests for:

- valid table and feature-layer queries;
- explicit field validation and automatic object-ID inclusion;
- optional geometry/`outSR` behavior;
- reversed/unsorted IDs and feature pages producing identical reports/hashes;
- max-record truncation selecting the same lowest canonical IDs;
- transfer-limit adaptive splitting;
- duplicate/missing/unrequested object IDs failing closed;
- request, byte, duration and cancellation ceilings;
- malformed metadata/IDs/features and server error envelopes;
- remote credential canaries absent from every serialized output/error/evidence field;
- executor boundary preflight plus per-dispatch boundary checks.

## Task 4: GISBench, docs and truth updates

**Files:**

- Add synthetic fixtures under `gisbench/fixtures/arcgis/query-*`;
- Add tasks 16–20 and corresponding golden outputs;
- Modify `dymaxion-runtime/src/gisbench/run.ts` and `gisbench/README.md`;
- Create `docs/capabilities/query-feature-service.md`;
- Update `README.md`, `CLAUDE.md` and fixture provenance.

Add five fixture-backed tasks:

1. basic attribute query with canonical object-ID paging;
2. optional geometry and output WKID;
3. transfer-limit split and response-order normalization;
4. max-record/byte/request ceiling behavior;
5. boundary, malformed or credential-bearing rejection.

State exactly four implemented native capabilities and twenty GISBench tasks only after implementation/tests exist. Document every deferred query mode and the anonymous/public visibility caveat.

## Task 5: Complete verification

Run and report real output:

```bash
cd dymaxion-runtime
npm ci
npm run typecheck
npm test
npm run gisbench
npm run build
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test
npm audit --omit=dev

cd ../dymaxion-admin
npm ci
npm test
npm run build
npm audit --omit=dev

cd ../windows-worker
npm ci
npm run typecheck
npm test
npm run build
npm audit --omit=dev

cd ..
docker compose --env-file .env.example config -q
git diff --check
```

Also scan every changed text file for literal NUL bytes, unexpected binary classification, oversized files, symlinks and known credential patterns. Use `scripts/ci_source_integrity.py` in a working-tree-suitable mode if supported; otherwise report that the exact base/HEAD comparison must be rerun after Mercator creates the local review commit.

## Acceptance gate

Implementation is locally ready only when:

- all code, focused/adversarial tests, fixtures, goldens and docs are present and scoped;
- every original criterion above is traceable to runtime code and a test or explicit rejection;
- all focused/full/build/benchmark/audit/Compose gates pass from the final tree;
- no real credentials, private data, live ArcGIS access, write operation or external publication occurred;
- `modelUsage` confirms `claude-fable-5` performed the implementation;
- Fable leaves the branch uncommitted for independent Mercator verification and exact-SHA Tyr review.
