# `generate_map_artifact` — Phase 1E native capability

Deterministic, read-only rendering of exactly one allowlisted local RFC 7946
GeoJSON FeatureCollection into a bounded, self-contained UTF-8 SVG returned
inline with a structured map report and reproducible evidence. The runtime
writes no artifact file and performs no network request.

Implementation: `dymaxion-runtime/src/capabilities/generate-map-artifact.ts`.
Dispatch: shared `runSkill()` executor, with strict schema validation and
boundary preflight before invocation persistence or file I/O.

## Locked scope

- One local `.geojson` FeatureCollection in `OGC:CRS84`
  longitude/latitude degrees.
- Inline SVG only (`image/svg+xml; charset=utf-8`).
- Closed style choices: `dymaxion`, `monochrome`, `blueprint`.
- Closed point symbols: `circle`, `square`.
- Static geometry primitives, fixed-padding fit-to-extent, structured legend,
  source attribution, geometry counts and QA metadata.
- No durable storage, output path, browser, HTML, PNG, PDF, basemap, labels,
  representative fraction, scale bar, projection transformation, geocoding,
  classification, statistics, analysis, publication or write approval.

## Input contract (schema `1.0.0`, strict)

| Field | Type | Contract |
| --- | --- | --- |
| `source_uri` | required string | Raw local `.geojson` filesystem path, max 4,096 chars. URI schemes, query/fragment delimiters, control characters, any `%`, credential-shaped assignments and raw Bearer/Basic material reject at schema validation before boundary audit, recorder or I/O. Bare relative paths gain an explicit `./` prefix. Raw spaces and Unicode are valid. Credential-ish words and ordinary non-sensitive assignments remain valid. |
| `target_format` | optional literal | Exactly `svg`; default `svg`. |
| `title` | optional string | 1–120 chars; default `Local GeoJSON map artifact`. Control and credential-shaped material reject. XML-escaped before rendering. |
| `purpose` | optional string | 1–240 chars; bounded deterministic default. Same text safety rules. |
| `audience` | optional string | 1–240 chars; default `GIS operator`. Same text safety rules. |
| `width` | optional integer | 320–1,600 px; default 800. |
| `height` | optional integer | 240–1,200 px; default 600. |
| `style` | optional enum | `dymaxion`, `monochrome`, or `blueprint`; default `dymaxion`. |
| `point_symbol` | optional enum | `circle` or `square`; default `circle`. |

Unknown fields reject. No credential field, output path, URL, CRS override,
style markup or arbitrary SVG fragment exists in the schema.

`source_uri` is deliberately a **raw path, not a URL**. Encoded, multiply
encoded, malformed and invalid-UTF-8 percent forms all reject without decoding
ambiguity. Fixed errors do not echo the supplied path or credential canary.

## GeoJSON and geometry contract

The root must be a FeatureCollection with a `features` array and must not
contain the removed legacy `crs` member. Every member must be a Feature with a
`geometry` member and object-or-null `properties`; missing or array-valued
properties reject. Supported geometry families:

- Point and MultiPoint;
- LineString and MultiLineString;
- Polygon and MultiPolygon, including multipart polygons and interior rings;
- GeometryCollection to depth 4; every collection member must be a Geometry
  object;
- null Feature geometry, counted and skipped with a warning.

Positions require at least longitude and latitude ordinates, and every present
ordinate must be a finite number. Longitude
must be in `[-180, 180]`, latitude in `[-90, 90]`. Higher ordinates are not
used for rendering. Non-empty LineStrings need at least two positions;
non-empty polygon rings need at least four and exact first/last 2D closure.
Empty coordinate arrays are non-drawable; a collection with no drawable
positions uses the explicit empty contract below.

Feature properties, property names, feature IDs, source names and arbitrary
source values are never rendered or copied into the report. This is a geometry
preview, not a property-label or thematic-map capability.

## Extent and viewport behavior

- `report.extent.source` is the exact bounded geometry extent, not the padded
  viewport. It is `null` when no drawable positions exist.
- One-point or otherwise degenerate longitude/latitude spans expand by exactly
  0.5 degrees on each degenerate axis for viewport fitting only.
- An empty/no-drawable collection uses viewport `[-180, -90, 180, 90]` and an
  explicit centered `Empty FeatureCollection: no drawable geometries` message.
- Longitude fitting chooses the deterministic minimal circular interval by
  removing the largest gap in normalized `[0, 360)` longitude space. Geometry
  coordinates are unwrapped into that interval before projection, so a
  dateline-crossing dataset does not stretch across the world.
- Non-crossing reported viewport longitudes are converted back to familiar
  `[-180, 180]` values. A crossing viewport remains an intentional unwrapped
  interval (for example `179.6` to `180.3`) and
  `antimeridian_crosses: true` states why.
- Rendering uses an affine degree-space fit with 48 px fixed padding and equal
  X/Y scale. It does **not** claim a projected cartographic scale,
  representative fraction or ground-distance accuracy.

## SVG safety and accessibility

SVG is assembled only by code-owned `svg`, `title`, `desc`, `rect`, `g`,
`path`, `polyline`, `circle` and `text` primitives. All user text is XML
escaped. Polygon holes use `fill-rule="evenodd"`.

The generated document has `role="img"`, linked title/description elements and
an inline source/limitations statement. A final safety scan rejects script,
event-handler attributes, `javascript:`, DTD/entity declarations,
`foreignObject`, `href`/`xlink:href` and CSS `url(...)`. It contains no external
font, image, stylesheet or other resource. Raw source properties are excluded
rather than sanitized into markup.

## Output contract (schema `1.0.0`, strict)

- `artifact`: exact inline SVG `content`, format, media type, UTF-8 byte count
  and SHA-256 of those exact bytes.
- `report`: source URI/handle, one-item source list and attribution, retrieval
  timestamp, source-byte hash/size, CRS and axis order, exact source extent,
  fitted viewport, geometry counts, deterministic style specification,
  structured legend, QA checks/warnings/limitations and mirrored artifact
  byte/hash metadata.
- `evidence`: deterministic EvidenceBundle with source-byte SHA-256, canonical
  parameter hash, GIS metadata, `execution.capability = generate_map_artifact`
  v1.0.0, and one `map_svg` output whose byte count and hash equal the exact SVG
  UTF-8 bytes.

Filesystem mtime is intentionally excluded (`source.version` is empty), so
identical source bytes, effective inputs and fixed `context.now` produce
byte-identical SVG, report and evidence regardless of checkout time.

## Hard ceilings

All ceilings are code constants and mirrored in the strict manifest. The
manifest schema was extended only with optional Phase 1E fields; unknown limit
keys still reject.

| Ceiling | Value |
| --- | ---: |
| Source bytes | 1,048,576 (checked after `stat` and again after read) |
| Features | 10,000 |
| Coordinate positions | 100,000 |
| GeometryCollection depth | 4 |
| SVG output | 200,000 UTF-8 bytes, enforced while lines are appended and verified after assembly |
| Width | max 1,600 px |
| Height | max 1,200 px |
| Title | max 120 chars |
| Purpose | max 240 chars |
| Audience | max 240 chars |
| Duration | 5,000 ms |
| Cost | $0 |

Cancellation/deadline checkpoints occur before I/O, after `stat`, before and
after `readFile`, after JSON parsing, throughout feature/geometry/coordinate
traversal, longitude/latitude extent work and SVG rendering. Native
`stat`, `readFile`, `JSON.parse` and JavaScript sort calls are synchronous or
awaited units and are not interrupted mid-call; cancellation is between those
steps, not falsely claimed as mid-I/O preemption.

## Boundary and I/O semantics

The shared boundary preflight runs before recorder/audit side effects. The
capability then canonicalizes the path and reasserts the trusted filesystem
boundary immediately before `stat` and again immediately before `readFile`.
Adapter errors surface as fixed stage-specific messages without path or native
error text. Credential-bearing path forms fail schema validation with zero
boundary audit, recorder, `stat` or `readFile` calls.

The adapter remains path-based. A filesystem race between the final boundary
assertion and the adapter's own open is therefore a residual TOCTOU window;
this capability does not claim descriptor-based race elimination.

## Deliberate limitations

This capability does not perform full RFC/OGC topology validation, polygon-hole
containment, cross-feature topology, simplification/generalization,
classification or statistical analysis. It does not inspect GeoJSON properties
for labels or categories. It accepts no non-GeoJSON vector/raster/database
source and runs no GDAL, QGIS, ArcPy, PostGIS, MCP or LLM call.

Use `validate_spatial_data` separately when a structured QA report is needed;
`generate_map_artifact` performs only the bounded structural/range/cardinality
checks needed to fail closed before rendering.

## GISBench and verification

Tasks 26–30 (`map-artifact-*`) cover useful mixed geometry, antimeridian
fitting, the empty collection contract, out-of-range rejection and filesystem
boundary rejection. Every fixture is synthetic CC0 test data. The runner
recomputes the raw source hash and validates exact SVG byte/hash agreement
across artifact, report and evidence before any environment-dependent path
normalization.

Commands:

```bash
cd dymaxion-runtime
node --import tsx --test test/generate-map-artifact.test.ts
npm run typecheck
npm test
npm run gisbench
npm run build
```

## Model provenance

The implementation plan and initial partial renderer/test draft were produced
by a delegated GPT-5.5 worker that timed out before completion. Mercator running
GPT-5.6 Sol/Codex inspected that untrusted partial diff, corrected and completed
the runtime, security boundaries, GISBench integration, documentation and
verification. Fable 5 did not author Phase 1E. Model attribution is phase-level;
no immutable per-line authorship claim is made.
