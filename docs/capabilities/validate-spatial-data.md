# `validate_spatial_data` — Phase 1D native capability

Deterministic, read-only, bounded spatial QA of exactly one allowlisted local
RFC 7946 GeoJSON FeatureCollection, producing a structured validation report
plus reproducible evidence. Implemented as a native runtime capability
(`dymaxion-runtime/src/capabilities/validate-spatial-data.ts`) dispatched
through the shared `runSkill()` executor with boundary preflight before any
invocation persistence or file I/O.

This capability performs the exact checks listed below and nothing more. It
**never claims full OGC Simple Features / GEOS validity**; every intentionally
unsupported topology/domain check is reported in `scope.checks_not_run` with a
stable identifier and reason.

## Input contract (schema `1.0.0`, strict)

| Field | Type | Notes |
| --- | --- | --- |
| `source_uri` | string, required | A bounded local `.geojson` filesystem path only (max 4,096 chars, no control characters, no URL query/fragment delimiters). Every URI/URL scheme — `http:`, `https:`, `file:`, `data:`, and any other — is rejected at the strict input schema with fixed messages that never echo the value, **before** boundary dispatch, invocation persistence, `stat`, or `readFile`. Ordinary relative and absolute local paths are preserved: bare relative paths (`x.geojson`) are normalized to an explicit `./` prefix at the schema so the shared executor boundary classifies them as filesystem inputs rather than URL fields, without weakening remote-URL rejection. The shared employer boundary then enforces the canonicalized path, and the capability re-asserts it at each I/O sink. Filesystem adapter exceptions (`ENOENT`, `EACCES`, …) are never propagated — `stat`/`read` failures surface as fixed stage-specific messages carrying no path or error text. |
| `max_bytes` | int, optional | Positive, capped at 1,048,576. |
| `max_features` | int, optional | Positive, capped at 10,000. |
| `max_issues` | int, optional | Positive, capped at 1,000; default 200. Controls returned finding detail only — validation always completes and summary totals count every finding. |

No check names, CRS overrides, credential-like fields, output paths, or remote
URLs are accepted; unknown fields are rejected.

## Checks run

Stable identifiers in `scope.checks_run`:

- `json_structure` — JSON syntax; root must be a `FeatureCollection` with a
  `features` array; every feature must be a `Feature` object with a
  `geometry` member and object-or-null `properties`. Envelope failures fail
  closed (capability error), never a partial report.
- `feature_ids` — string/number IDs accepted; missing IDs are warnings;
  duplicate typed canonical IDs are errors (string `"7"` and number `7` are
  distinct); other ID types are errors.
- `null_geometry` — null geometries are warnings.
- `geometry_types` — Point, MultiPoint, LineString, MultiLineString, Polygon,
  MultiPolygon, GeometryCollection; anything else is an error (the raw type
  value is never echoed).
- `geometry_structure` — coordinate containers must have the correct nesting
  for the type; empty `MultiPoint` / `MultiLineString` / `Polygon` /
  `MultiPolygon` coordinate containers (including an empty per-polygon ring
  array) are `geometry_empty` errors.
- `coordinate_dimensions` — positions need at least two finite numeric
  ordinates; dimensions must be internally consistent within each geometry
  **and across GeometryCollection members**. A collection whose
  individually-consistent children disagree gets one
  `coordinate_dimension_mismatch` at the collection path; an internally mixed
  child carries its own finding without a duplicate at the collection level.
- `coordinate_range_crs84` — longitude `[-180, 180]`, latitude `[-90, 90]`
  when the effective CRS is CRS84 (see CRS handling below); otherwise this
  identifier moves to `checks_not_run`.
- `linestring_cardinality` — LineStrings need at least two positions.
- `ring_cardinality` / `ring_closure` — polygon rings need at least four
  positions and exact first/last position equality.
- `duplicate_vertices` — consecutive duplicate vertices (warning, with
  occurrence counts in metrics).
- `ring_zero_area` — zero signed shoelace area rings are errors.
- `ring_self_intersection_bounded` — deterministic O(n²) 2D segment-pair
  check per ring that skips adjacent segments and the first/last adjacency;
  rings above 512 segments skip the check with an explicit warning finding
  (`ring_self_intersection_check_skipped`), never silently. This bounded
  check is not full OGC validity and is labelled as such.
- `bbox` — declared bboxes are validated wherever RFC 7946 §5 permits them:
  on the root FeatureCollection, on each Feature (scoped to that feature's
  geometry positions), and on any geometry object including
  GeometryCollection members (scoped to that geometry's own positions).
  Structure requires `2*n` finite values with `2 <= n <= 16` dimensions and
  `min <= max` on every non-longitude axis (`bbox_invalid`); the dimension
  bound keeps bbox axis loops bounded and paced. Under effective CRS84, the
  longitude axis values must lie in `[-180, 180]` and latitude values in
  `[-90, 90]` (`bbox_out_of_range`); ranges are never applied to other axes
  or to an unknown legacy CRS. The bbox length must be `2*n` for the
  dimensionality observed in its scope (`bbox_dimension_mismatch`); mixed
  coordinate dimensions in a scope are themselves a deterministic
  `bbox_dimension_mismatch` error and never suppress enclosure findings:
  containment is always evaluated over the axes the bbox actually
  represents, an observed escape is reported as `bbox_not_enclosing` and a
  sound `encloses_computed: false`, while full enclosure across broken
  dimensionality is never confirmed (the metric abstains with `null`).
  Enclosure is
  verified per validated position **in every represented dimension** (Z and
  higher axes included — a 3D bbox whose Z range excludes a coordinate is
  `bbox_not_enclosing`), so antimeridian-crossing CRS84 bboxes
  (`west > east`, all values in range, longitude inside when
  `x >= west || x <= east`) are decided exactly. A crossing bbox under a
  non-CRS84 legacy CRS cannot be verified and yields an explicit
  `bbox_enclosure_unverified` warning. `metrics.bbox`
  (`declared_present` / `declared_valid` / `computed_extent` /
  `encloses_computed`) remains **root-focused by contract**; Feature- and
  geometry-level bbox findings carry their own stable locations
  (`bbox`, `geometry.bbox`, `geometry.geometries[i].bbox`).
- `property_null_profile` — null/missing counts per property field, stably
  sorted by display name (code-unit order, never locale-sensitive). Field
  names are displayed verbatim only when safe (1–64 chars, no control
  characters, not credential-shaped under the shared reviewed
  key-classification helpers); empty, overlong, control-bearing, or
  credential-like names are displayed everywhere in report and evidence as a
  deterministic non-reversible surrogate
  (`field_sha256_<full-64-hex-SHA-256-of-the-raw-name>`) with one
  `property_field_name_sanitized` warning per affected unique field. The
  `field_sha256_` prefix is a reserved Dymaxion-owned namespace: any raw
  field name beginning with it is itself surrogated, so no source name can
  impersonate a generated display name short of an actual SHA-256 collision.
  Surrogates are deterministic and collision-resistant, not mathematically
  collision-free. Metrics stay keyed by the raw field, so distinct raw
  fields never merge, and an empty property name validates successfully
  through the same path.

## Checks not run (always reported)

- `ogc_simple_features_validity` — no GEOS-equivalent validity claim.
- `polygon_hole_containment` — interior-ring containment/overlap unchecked.
- `cross_feature_topology` — overlaps/gaps/shared boundaries unchecked.
- `coded_value_domains` — GeoJSON defines no coded-value domains; reported
  as not applicable rather than invented.
- `coordinate_range_crs84` — only when a legacy `crs` member names an
  unrecognized CRS (see below).

## CRS handling

Absence of the deprecated `crs` member means RFC 7946 `OGC:CRS84`
(longitude/latitude, degrees). A present legacy `crs` member always yields a
`crs_member_deprecated` warning; if its name is exactly a recognized CRS84
alias (`urn:ogc:def:crs:OGC:1.3:CRS84`, `urn:ogc:def:crs:OGC::CRS84`,
`OGC:CRS84`, `CRS84`) range checks stay on and the exact alias is reported.
Any other (unrecognized or malformed) legacy CRS name is untrusted dataset
content and is **never serialized**: `declared` and `effective` are reported
as `null`, CRS84 range assumptions are disabled and reported in
`checks_not_run`, and the warning carries no raw content.

## Findings and determinism

Findings are `{ code, severity (error|warning), location { feature_index,
path }, message }` with machine-readable codes and bounded messages. Raw
untrusted values — feature IDs, geometry type strings, coordinates, property
values — never appear in findings, capability errors, or evidence; locations
use stable indices and JSON-path-style strings instead.

Findings are ordered by severity rank, code, feature index, path, then
message — a total order independent of encounter order. Retention is a
deterministic bounded top-K: at most `2 × max_issues` records are ever held
in memory, and the returned set exactly equals sorting the full logical
finding set and taking the first `max_issues`. `summary` reports full
`error_count` / `warning_count` / `total_finding_count` alongside
`returned_finding_count` and `findings_truncated`, so returned-detail
truncation is never conflated with validation incompleteness. `valid` is
false exactly when at least one error-severity finding exists.

Same input bytes, options, and fixed `context.now` produce byte-identical
report and evidence hashes.

## Resource ceilings (hard failures, mirrored in the manifest)

Every ceiling below is traceable in the strict capability manifest: the
standard `resource_limits` fields plus the additive optional fields
`max_coordinate_positions`, `max_returned_issues`,
`max_geometry_collection_depth`, and `max_self_intersection_segments`
(older capability manifests simply omit them).

| Ceiling | Value |
| --- | --- |
| File bytes | 1,048,576 (stat before read, re-checked after read) |
| Features | 10,000 (checked before any geometry traversal) |
| Coordinate positions | 100,000 |
| GeometryCollection depth | 4 |
| Returned findings | default 200, hard max 1,000 |
| Duration | 5,000 ms |
| Cost | $0 |

Cancellation and the deadline are checkpointed around every I/O and parse
step — immediately after `stat` (an abort during `stat` produces zero
reads), before and after `readFile`, and after JSON parsing but **before**
malformed-JSON or root-invalid errors, so slow parse paths cannot bypass the
duration ceiling — and inside every potentially large loop (feature
envelopes, geometry/coordinate traversal, duplicate-vertex scans, ring area,
self-intersection pairs, property profiling, report finalization). The
underlying `stat`/`readFile` adapter calls themselves are not raced or
interrupted mid-call; checkpoint semantics are between-step, which is stated
here honestly rather than claimed as mid-I/O abortability. A byte/feature/
coordinate/depth/deadline ceiling or cancellation is a hard capability
failure, never a partial "valid" report.

The shared filesystem boundary is additionally re-asserted on the canonical
path immediately before each I/O sink (`stat` and `readFile`), with the
trusted boundary/audit context, so direct capability execution and
symlink/realpath swaps after the executor preflight are still blocked. The
adapter contract is path-based, so a filesystem race between the final
assertion and the adapter's own open remains theoretically possible; that
residual TOCTOU window is documented here rather than claimed away.

## Evidence

`EvidenceBundleSchema` with: source hash = raw file-byte SHA-256; parameter
hash over the canonical source URI and effective limits; output hash over the
unnormalized validation report; `execution.capability =
validate_spatial_data` v1.0.0, deterministic, no model planning; empty
approvals and no rollback (read-only). `source.version` is deliberately an
empty object — filesystem mtime never enters this capability's evidence, so
identical bytes, options, and fixed clock produce byte-identical report
**and** evidence regardless of checkout times.

`evidence.outputs[0].validation.valid` carries truthful semantics: for this
validation-report artifact it mirrors `report.summary.valid`, so downstream
evidence consumers can never mistake an invalid dataset for a valid one.
GISBench validates the parameter and output hashes before golden
normalization and additionally **recomputes** the source SHA-256 from the
actual raw fixture bytes, requiring both the report and evidence source
hashes to equal it — jointly forged hashes fail closed.

## Non-goals (Phase 1D)

No network, ArcGIS REST, or authenticated services; no shapefile, GeoPackage,
File Geodatabase, CSV, raster, or database inputs; no reprojection, repair,
mutation, publication, or write approvals; no external processes
(GDAL/QGIS/ArcPy/PostGIS), MCP, or LLM calls.

## Verification

- Focused: `cd dymaxion-runtime && node --import tsx --test test/validate-spatial-data.test.ts`
- GISBench tasks 21–25 (`validate-*`): valid polygon, geometry findings,
  identifier/null QA, stable issue-ceiling truncation, boundary rejection —
  all against committed synthetic fixtures under
  `gisbench/fixtures/spatial-validation/`.
