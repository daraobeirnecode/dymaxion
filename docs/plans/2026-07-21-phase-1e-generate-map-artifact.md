# Phase 1E `generate_map_artifact` Implementation Plan

**Goal:** Add a deterministic, read-only native capability that renders one bounded local RFC 7946 GeoJSON `.geojson` file into a self-contained inline UTF-8 SVG artifact with reproducible evidence. The capability performs no writes, no network access, no basemap/labeling/statistical analysis, and no durable artifact publication.

## Locked MVP scope

- Capability slug: `generate_map_artifact`, version `1.0.0`, classification `read`.
- Input accepts only strict raw local `.geojson` `source_uri`; no URI schemes, percent escapes, query/fragment, controls, credential-shaped assignments, or raw Bearer/Basic material. Rejections occur at schema validation before boundary audit, invocation persistence, filesystem stat/read, output, report, or evidence construction.
- Additional bounded inputs: title, purpose, audience, width, height, target format exactly `svg`, optional closed style/symbol choices. Unknown fields reject.
- Reads exactly one allowed local source through the shared boundary, reasserting the filesystem boundary immediately before `stat` and `readFile`.
- Parses RFC 7946 FeatureCollections in CRS84 longitude/latitude, checks finite longitude/latitude ranges, supports Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection, multipart geometries and polygon holes.
- Antimeridian handling uses a deterministic minimal longitude interval/unwrap center so crossing datasets do not stretch across the world.
- Empty collection and degenerate point/line extents have explicit deterministic viewport behavior.
- SVG is generated only from closed XML primitives. It contains no script, event handlers, external URLs/resources, DTD/entity declarations, `foreignObject`, raw source properties, feature names, or raw user markup. All text is XML-escaped.
- Output returns inline SVG content, media type, byte count, SHA-256 of exact UTF-8 bytes, structured QA checks/warnings/limitations, source hash/timestamp, geometry counts, extent/CRS/axis order, viewport, attribution, and an EvidenceBundle whose output hash equals the exact SVG byte hash.
- Hard ceilings: source bytes, feature count, coordinate positions, GeometryCollection depth, width/height, title/purpose/audience chars, SVG output bytes, duration, cancellation checkpoints. Every ceiling is mirrored in the manifest via additive strict resource-limit schema fields.

## Implementation steps

1. Extend manifest schema additively for Phase 1E-specific ceilings while preserving strict unknown-limit rejection.
2. Implement `dymaxion-runtime/src/capabilities/generate-map-artifact.ts` following Phase 1D boundary, raw-path/no-percent, recorder-preflight and fixed non-echoing I/O error patterns.
3. Register the native capability in `src/capabilities/registry.ts` and update capability count/docs references.
4. Add focused tests for schema/manifest, geometry families, antimeridian, holes/multipart/GeometryCollection, empty/point/degenerate extents, malformed/out-of-range/null/unsupported structures, XML injection neutralization, credential/raw/encoded denied paths with zero sinks, benign raw spaces/Unicode/credential-ish words/ordinary assignments, resource/duration/cancellation limits, deterministic evidence/output hashes and strict output shape.
5. Extend GISBench from 25 to 30 tasks with exactly five Phase 1E tasks/goldens/fixtures: useful geometry map, antimeridian, empty/point, malformed/range rejection, boundary rejection. Update GISBench task schema, allowed operations, normalization and hash validation without weakening prior tasks.
6. Update README, CLAUDE.md, GISBench README/provenance and add `docs/capabilities/generate-map-artifact.md` documenting inline SVG-only semantics, no writes/storage/scale/basemap/labels/analysis, raw path contract, source limitations, security semantics and actual model attribution.
7. Verify with focused tests, typecheck, full runtime tests, GISBench, build/smoke/audit as practical, then inspect diff/status. Do not commit or push.

## Verification contract

Success requires deterministic byte-identical SVG/evidence for fixed source bytes, options and clock; source SHA-256 must match raw bytes; parameter hash must validate; evidence output hash must equal `sha256(svg_content)`; denied credential/path inputs must show zero boundary audit, recorder, stat/read and no canary/source echo.
