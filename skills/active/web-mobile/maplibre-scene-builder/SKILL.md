---
slug: maplibre-scene-builder
name: MapLibre Scene Builder
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# MapLibre Scene Builder

## Purpose

Build a complete MapLibre GL style JSON (spec v8) for a set of PostGIS-backed
MVT layers. Inspects each source table via postgres-mcp, classifies a chosen
attribute (quantile/equal-interval/categorical), and generates data-driven
paint/layout rules per layer. Output is a style document, not an app — any
MapLibre client can consume it.

## When to use this skill

- User has PostGIS tables served as MVT (pg_tileserv/Martin) and wants a styled
  map ("style these layers", "make a choropleth from this table")
- A scaffolded app needs a real style JSON instead of a demo basemap
- Styling rules should be derived from actual data distribution, not guessed

## When NOT to use this skill

- Layers are ArcGIS Feature Services — renderer belongs in the app; use
  `arcgis-maps-sdk-integration`
- User wants an app scaffold — use `nextjs-map-app-scaffold` or
  `pwa-map-scaffold`, optionally chained after this skill
- Source data is files (GeoJSON/GPKG), not PostGIS — load to PostGIS first
  (Category B skill) or hand-style

## Inputs

- `layers` (array, required): descriptors
  `{ table, geometry_type, style_field?, classification? }` where
  `classification` is `quantile | equal_interval | categorical`
- `tile_base_url` (string, required): MVT endpoint base, e.g.
  `https://tiles.example.com` (pg_tileserv/Martin URL pattern appended per table)
- `basemap_style` (string, optional): base style URL to merge under the data
  layers. Default: none (data-only style)
- `classes` (number, optional, default 5): class count for numeric ramps
- `output_path` (string, required): where to write the style JSON

## Outputs

- `style_path` (string): absolute path of the written style JSON
- `style_json` (object): the full style document
- `layer_summaries` (array): per layer — field classified, method, class breaks,
  colors used, feature count sampled

## Tools required

- `postgres-mcp` — inspect table schemas, geometry types, and attribute
  distributions (`percentile_disc`, `DISTINCT` counts)
- `filesystem-mcp` — write the style JSON

## Execution plan

1. Validate every `layers[].table` exists via postgres-mcp catalog query; read
   geometry type and SRID from `geometry_columns`; fail per-layer, not per-run
2. For each layer with a `style_field`: sample the column — numeric fields get
   percentile breaks for `quantile` or min/max for `equal_interval`;
   text fields get `DISTINCT` values (cap 12) for `categorical`
3. Compute class breaks and a colorblind-safe ramp sized to `classes`
4. Generate style layers (LLM step below): one `source` per table using
   `{tile_base_url}/{schema.table}/{z}/{x}/{y}.pbf`, paint expressions using
   `step`/`match` on the classified field, sensible zoom ranges by geometry type
5. If `basemap_style` given, fetch it and merge: basemap sources+layers first,
   data layers appended above labels where possible
6. Validate the assembled document against the MapLibre style spec (required
   root keys, unique layer ids, source references resolve)
7. Write to `output_path`; return style, path, and per-layer summaries

## LLM prompts

### Generate style layers

System: You are a cartographer writing MapLibre GL style spec v8 JSON. Use only
expression syntax valid in MapLibre (no Mapbox-only properties). Output strictly
the JSON array of layer objects, no prose.

User: Source layers: {layer_specs_json}. For each, geometry type, classified
field, method, breaks, and hex ramp are given. Produce layer objects with
appropriate type (fill/line/circle), `step` or `match` paint expressions on the
breaks, 0.85 fill-opacity for polygons with a darker outline line layer, and
minzoom chosen by geometry density hint.

## Failure modes

- Table missing or has no geometry column → drop that layer, continue, list it
  in `layer_summaries` with `status: skipped` and the reason
- `style_field` has >12 distinct categorical values → keep the 11 most frequent
  plus an `other` bucket; note the truncation in the layer summary
- Basemap style URL unreachable → emit data-only style and add a note; do not
  fail the run
- postgres-mcp connection refused → retry once after 10s, then fail with the
  connection error and no partial file written

## Cost + timeout

- Max cost per invocation: $0.40
- Max duration: 600 seconds
- Typical actual cost: $0.20, typical duration: 45 seconds
