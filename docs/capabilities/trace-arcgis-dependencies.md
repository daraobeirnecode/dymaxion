# `trace_arcgis_dependencies` — Phase 1B native capability

Deterministic, read-only downstream dependency graph for ArcGIS Online or
ArcGIS Enterprise items over the Portal REST API. Implemented as a native
runtime capability
(`dymaxion-runtime/src/capabilities/trace-arcgis-dependencies.ts`) on the
reusable ArcGIS REST transport
(`dymaxion-runtime/src/capabilities/arcgis-rest.ts`).

## What it does

Given an approved HTTPS portal root and 1–25 root item IDs (each exactly 32
hexadecimal characters), it traverses the MVP dependency chain

```
Web Mapping Application → Web Map → item/service references
```

and reports a bounded, canonical graph:

- **Nodes** — `item:<item-id>` for portal items (identity, type, title,
  owner, access where visible; support status `expandable | terminal |
  missing | unfetched`) and `service:<sha256>` (the full SHA-256 of the
  sanitized URL — never a truncated prefix) for service URL leaves; any
  identity collision between different sanitized URLs fails the run closed
  instead of merging nodes;
- **Edges** — typed (`web_map | operational_layer | table | basemap_layer`)
  with a controlled, index-free JSON-path locator, deduplicated canonically;
- **Cycles** — strongly connected components (including self-loops) as
  canonically sorted node-ID sequences; traversal always terminates via
  visited-state plus ceilings;
- **Impact** — per-node upstream/downstream reachable counts computed only
  within the discovered graph;
- **Unresolved references** — malformed item IDs, unparseable/non-HTTP
  URLs, and credential-bearing URLs, with deterministic reasons and no raw
  values;
- **Truncation** — explicit reasons whenever a depth/node/edge/request
  ceiling bound the traversal;
- **Evidence** — versioned bundle (`schema_version 1.1.0`) with canonical
  parameters, per-request URL/status/SHA-256/bytes in real dispatch order,
  and the canonical report hash.

## Exactly supported item types and JSON paths

Only these paths are parsed. There is no recursive scraping of arbitrary
strings, IDs, or URLs, and no other item type is expanded.

| Item type | Path | Meaning |
|---|---|---|
| Web Mapping Application (data) | `map.itemId` | referenced web map |
| Web Mapping Application (data) | `values.webmap` (string or array of strings) | referenced web map(s) |
| Web Map (data) | `operationalLayers[].itemId` / `operationalLayers[].url` | layer item / service URL |
| Web Map (data) | `tables[].itemId` / `tables[].url` | table item / service URL |
| Web Map (data) | `baseMap.baseMapLayers[].itemId` / `baseMap.baseMapLayers[].url` | basemap item / service URL |

ArcGIS Dashboards, Experience Builder, StoryMaps, and arbitrary Web Mapping
Application templates are **not** supported: such items (and every
service-backed or other type) are terminal item nodes with an explicit
support status. An application whose data contains none of the supported
fields produces a deterministic warning, not a guess.

## Read-only guarantees and security posture

- Classification `read`; no approval is requested and no write endpoint is
  ever called.
- Requests are constructed **only** from the validated portal root plus
  validated lowercase 32-hex item IDs — exactly two endpoint shapes:
  `/sharing/rest/content/items/{id}?f=json` and
  `/sharing/rest/content/items/{id}/data?f=json`.
- **Item-provided service URLs are never dispatched.** They are sanitized
  (https/http only, userinfo-bearing URLs rejected, query/fragment stripped)
  into terminal `service:` nodes whose IDs are the full SHA-256 of the
  sanitized URL, so no credential or signed query string can reach output.
  The PATH is additionally decoded to a stable point with a bounded pass
  ceiling (3). Credential-shaped assignments, Bearer/Basic authorization
  material, and narrow adjacent key/value conventions such as
  `/apikey/{value}` or `/access_token/{value}` are checked after **every**
  decode pass, so singly or multiply percent-encoded smuggling
  (`/token=…`, `/token%3D…`, `/api%5Fkey/{value}`) is rejected as
  `credential_bearing_url` without echoing the raw value. Malformed percent
  encoding or nesting beyond the pass ceiling fails closed as
  `unparseable_url`. Ordinary service names —
  including percent-encoded names like `Fire%20Hydrants` and a segment
  literally named `token` without an assignment — are unaffected.
- No credential field exists in the input schema; token/key/password-like
  fields are rejected. Item metadata, data, titles, owners, URLs, and ArcGIS
  error envelopes are untrusted data, never instructions; envelope messages
  are redacted before any error propagates and are never copied into
  warnings, and item `type`/`title`/`owner` metadata is redacted and
  length-capped before serialization so credential-shaped values cannot
  reach output, evidence, warnings, or errors (legitimate ArcGIS type names
  pass through unchanged, so classification is unaffected).
- **Every received response is accounted.** Tolerated per-item failures
  (error envelopes, HTTP 4xx) still count their bytes against
  `max_total_response_bytes` — repeated error responses cannot evade the
  total ceiling — and their sanitized request records (constructed URL,
  status, body hash, byte count; never body content) appear in evidence in
  actual dispatch order, exactly once. `totals.request_count` counts
  dispatched requests and equals the recorded evidence entries on every
  successful run.
- Every outbound URL passes the Phase 0 employer-boundary checks (allowlist,
  hostname denylist, DNS/IP SSRF checks) immediately before dispatch — once
  at the executor preflight and again per request.
- Redirects are never followed. Conflicting item identities (a portal
  echoing a different item ID), malformed JSON, unexpected content types,
  5xx responses, and byte/duration ceilings fail the run closed. A missing
  or inaccessible single item (ArcGIS error envelope or HTTP 4xx) becomes a
  `missing` node with a deterministic warning instead of failing the trace —
  but the per-response byte ceiling is classified before HTTP status, so an
  oversized response fails the run closed even when its status would
  otherwise be tolerated.
- Cancellation is honored before every request, re-checked immediately after
  the asynchronous boundary preflight (DNS resolution/audit) and before
  transport dispatch, and checked during traversal.

## Determinism

Traversal itself is canonical: the deduplicated roots, every breadth-first
level, and each item's parsed references are sorted before any
node/edge/request ceiling is applied, so even the graph content selected
under an active ceiling — which nodes, edges, and requests survive — is
independent of input root order and remote reference-array order. Nodes,
edges, cycles, unresolved references, warnings, and truncation reasons are
canonically sorted and deduplicated, and node depth is the minimum
breadth-first distance from any root, so the report and its output hash are
independent of root order, reference-array order, page order, and JSON
object-key order. Request evidence records the actual dispatches in that
canonical dispatch order; response body hashes in evidence may still differ
between logically identical runs (for example, different object-key order)
while the canonical report hash stays equal.

## Limits (enforced, not advisory)

| Limit | Input field | Range | Default |
|---|---|---|---|
| Roots | `root_item_ids` | 1–25 unique 32-hex IDs | — |
| Depth | `max_depth` | 1–6 | 4 |
| Nodes | `max_nodes` | 1–500 | 200 |
| Edges | `max_edges` | 1–1000 | 400 |
| Requests | `max_requests` | 1–1000 | 200 |
| Bytes per response | `max_response_bytes` | 1 KiB–2 MiB | 2 MiB |
| Total response bytes | `max_total_response_bytes` | 1 KiB–8 MiB | 8 MiB |
| Duration | `max_duration_ms` | 1–30 s (10 s per request) | 30 s |

Depth/node/edge/request ceilings truncate honestly
(`truncation.reasons`, caveats); byte and duration ceilings fail the run.
The manifest `resource_limits.max_records` is the honest output ceiling of
1500 (500 nodes + 1000 edges).

## Visibility caveats

The graph covers only content visible to the configured identity at the
approved portal (anonymous/public in Phase 1B) and only the supported JSON
paths; the output always carries caveats that it is not proof of a complete
dependency inventory, that services were never contacted, and — when
present — that missing/unresolved references may understate impact.

## Invoking with the synthetic fixtures

No live portal is required. The committed GISBench fixtures under
`gisbench/fixtures/arcgis/dependency-*` exercise the full
metadata/data/graph path through an injectable transport with stubbed DNS
(tasks 11–15, `npm run gisbench` from `dymaxion-runtime/`). The focused test
suite is `dymaxion-runtime/test/trace-arcgis-dependencies.test.ts`.
