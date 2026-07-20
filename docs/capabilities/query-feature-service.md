# `query_feature_service` — Phase 1C native capability

Deterministic, read-only attribute (and optional geometry) query against one
approved anonymous/public ArcGIS Feature Service layer. Implemented as a
native runtime capability
(`dymaxion-runtime/src/capabilities/query-feature-service.ts`) on the
reusable ArcGIS REST transport
(`dymaxion-runtime/src/capabilities/arcgis-rest.ts`), which gained
non-breaking bounded POST-form support in this phase.

## What it does

Given one approved HTTPS URL ending exactly in `/FeatureServer/<layer-id>`
and 1–100 explicit field names, it:

1. **GETs the layer metadata** (`<layer_url>?f=json`) and validates it
   strictly: the type must be `Feature Layer` or `Table`, `capabilities`
   must include `Query`, the fields array must be valid and
   case-insensitively unique, and exactly one unambiguous object-ID field
   must exist (a declared `objectIdField` of type `esriFieldTypeOID`, or
   exactly one `esriFieldTypeOID` field). A missing/invalid positive
   `maxRecordCount` falls back to a documented bound of 1000 with a warning.
   An echoed layer id that differs from the requested one fails closed.
2. **Validates the requested fields** against the metadata
   case-insensitively and emits canonical metadata names. The object-ID
   field is automatically included in the effective query fields. Unknown
   requested fields fail closed; metadata fields with credential-like names
   are excluded from the queryable set (never returned as likely secrets).
3. **Discovers object IDs** with a POST form (`returnIdsOnly=true` plus the
   `where` predicate, default `1=1`), then canonicalizes them — safe
   integers only, duplicates fail closed, sorted ascending — **before** the
   `max_records` ceiling selects the lowest survivors. `total matched`,
   selected count, and truncation are reported truthfully. If ID discovery
   itself reports `exceededTransferLimit`, the run fails closed rather than
   claiming that the returned ID set is complete.
4. **Retrieves features in deterministic object-ID batches** (batch size =
   min(`page_size`, service `maxRecordCount`, 2000)) with explicit
   `outFields`, `returnGeometry`, and optional `outSR`. If a page reports
   `exceededTransferLimit`, the requested batch splits into deterministic
   halves and re-enters the queue at the front (ascending order preserved);
   a singleton that still exceeds fails closed. Every attempt counts
   against the request/byte/duration ceilings and appears in evidence.
5. **Checks response identity and completeness strictly**: every feature
   must carry exactly one safe-integer object-ID attribute from the
   requested batch; duplicate, unrequested, or (on a non-exceeded page)
   missing IDs fail closed, as does a run whose returned records do not
   equal the selected IDs.
6. **Reports canonically**: features sorted by object ID with canonical
   attribute keys (missing requested attributes become explicit `null`s
   with a warning; unexpected attributes are discarded with a warning),
   sorted deduplicated warnings/truncation reasons, exact totals (matched /
   selected / returned / requests / bytes), fixed support caveats, and a
   versioned evidence bundle (`schema_version 1.2.0`).

## Explicitly out of scope (rejected by the strict input schema)

Statistics/group-by/order-by, geometry filters and spatial relations, datum
transformations, attachments, related records, time queries, gdb versions,
MapServer/ImageServer layers, wildcard (`*`) or duplicate field requests,
credential-like inputs of any kind, and every write/edit/export/sync/publish
operation. These are later slices; there are no partial implementations or
speculative switches.

## Read-only guarantees and security posture

- Classification `read`; no approval is requested and no write endpoint is
  ever called.
- Requests go only to the validated layer URL and to `<layer_url>/query`,
  derived solely by appending `/query`. **No remote-returned URL is ever
  dispatched.**
- **Query values never appear in URLs.** The `where` predicate, object-ID
  lists, and field lists travel in POST form bodies. Evidence records the
  HTTP `method` and a canonical `request_sha256` (SHA-256 of the
  key-sorted `application/x-www-form-urlencoded` body); bodies are never
  serialized into evidence, logs, or errors, and query evidence URLs carry
  no query string. The metadata GET carries only the fixed `f=json` format
  token. The `where` predicate is deliberately part of canonical parameter
  evidence — it is operator input required for reproducibility.
- The strict input schema rejects credential-like keys and field names;
  `layer_url` refuses traversal/encoded/backslash segments, userinfo, query
  strings, and fragments; `where` refuses control characters and
  credential-shaped material.
- Layer metadata, field names, attribute values, geometry payloads, and
  ArcGIS error envelopes are untrusted data, never instructions. Metadata
  strings are redacted and length-capped; attribute strings are redacted;
  geometry is recursively sanitized with bounded depth/node budgets and
  credential-like keys removed; error-envelope text is redacted before any
  error propagates.
- Every outbound request passes the Phase 0 employer-boundary checks
  (allowlist, hostname denylist, DNS/IP SSRF checks) immediately before
  dispatch — once at the executor preflight and again per request.
  Cancellation is honored before retrieval, re-checked immediately after
  the asynchronous boundary preflight (DNS/audit) and before transport
  dispatch, and checked before every batch; an abort during preflight means
  zero dispatches.
- Redirects are never followed. HTTP errors, unexpected content types,
  malformed JSON, and HTTP-200 ArcGIS error envelopes fail the run closed;
  received bytes are counted exactly once (success or typed failure) and
  every dispatched attempt appears in evidence in dispatch order.
- A transport without POST support fails closed before any query dispatch.

## Determinism

Object-ID order and feature response order cannot alter the selected
records, the report order, or the canonical output hash: IDs are sorted
ascending before the record ceiling selects the lowest survivors, batches
are formed from the sorted list, transfer-limit splits preserve ascending
order, and the final features are emitted in object-ID order with canonical
attribute keys. Requested fields are canonicalized to sorted metadata
names. Warnings, truncation reasons, and caveats are sorted and
deduplicated. Request evidence records actual dispatches in deterministic
dispatch order; response body hashes may differ between logically identical
runs while the canonical report hash stays equal.

When layer metadata exposes both a legacy `wkid` and `latestWkid`, source and
implicit output spatial-reference reporting uses `latestWkid`. For geometry
queries, every feature-page response must expose a valid top-level
`spatialReference`; its normalized `latestWkid`/`wkid` must agree with the
requested `out_sr` or metadata-derived source WKID and remain consistent across
split pages. Missing or mismatched response CRS fails closed. Evidence records
this Esri identifier as `WKID:<number>` rather than assuming every WKID belongs
to the EPSG authority.

## Limits (enforced, not advisory)

| Limit | Input field | Range | Default |
|---|---|---|---|
| Where length | `where` | 1–2048 chars | `1=1` |
| Fields | `out_fields` | 1–100 unique explicit names | — |
| Output WKID | `out_sr` | positive integer, geometry only | source SR |
| Batch size | `page_size` | 1–2000 (capped by `maxRecordCount`) | `maxRecordCount` |
| Records | `max_records` | 1–10,000 | 1000 |
| Requests | `max_requests` | 1–200 | 100 |
| Bytes per response | `max_response_bytes` | 1 KiB–2 MiB | 2 MiB |
| Total response bytes | `max_total_response_bytes` | 1 KiB–16 MiB | 16 MiB |
| Duration | `max_duration_ms` | 1–30 s (10 s per request) | 30 s |

The `max_records` ceiling truncates honestly (lowest canonical object IDs,
explicit reasons, caveat). Request, per-response byte, total byte, and
duration ceilings fail the run closed rather than return an incomplete
result set silently.

## Visibility caveats

The query runs with anonymous/public visibility only (no trusted ArcGIS
credential provider exists yet); records not visible to that identity are
absent, and the report always says so. Enterprise layers on custom domains
require explicit `config/employer-boundary.yaml` allowlisting; City of
Sacramento deny rules always win.

## Invoking with the synthetic fixtures

No live service is required or permitted in tests. The committed GISBench
fixtures under `gisbench/fixtures/arcgis/query-*` exercise metadata, ID
discovery, batch paging, transfer-limit splitting, record ceilings, and
boundary rejection through an injectable exact-match transport (method +
URL + canonical POST form) with stubbed DNS (tasks 16–20, `npm run
gisbench` from `dymaxion-runtime/`). The focused test suite is
`dymaxion-runtime/test/query-feature-service.test.ts`.
