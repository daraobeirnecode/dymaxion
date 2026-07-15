---
slug: osm-extract
name: OSM Extract
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# OSM Extract

## Purpose

Extract OpenStreetMap features matching a tag filter within a bbox, via either
the Overpass API (small/medium areas, always-fresh data) or a local `.pbf`
planet extract processed with osmium (large areas, reproducible, no rate
limits). Output as GeoJSON or GeoPackage with normalized tag columns.

## When to use this skill

- Pulling roads, buildings, POIs, landuse, waterways etc. for an AOI
- Building basemap or analysis layers where OSM is an acceptable source
- Repeatable extracts from a pinned `.pbf` snapshot (audit-friendly)

## When NOT to use this skill

- Continental/planet-scale tag analytics — convert the pbf to GeoParquet and
  use `duckdb-spatial-analytics` or `sedona-spark-analytics`
- Authoritative cadastral/address data is required — OSM completeness varies;
  prefer the jurisdiction's open data via `gdal-format-convert`
- The AOI + tag combination is huge over Overpass (e.g. all buildings for a
  country) — switch `source` to `pbf` or expect rate-limit failures

## Inputs

- `bbox` (array, required): `[west, south, east, north]` in WGS84
- `tags` (object, required): tag filter map, e.g. `{"highway": "*"}` or
  `{"amenity": ["school", "hospital"]}`; keys AND-ed, list values OR-ed
- `source` (string, optional, default `overpass`): `overpass` or `pbf`
- `pbf_path` (string, optional): local `.pbf` path; required when `source: "pbf"`
- `output_format` (string, optional, default `geojson`): `geojson` or `gpkg`

## Outputs

- `output_path` (string): path to the extracted dataset under
  `/workspace/data/osm/`
- `extract_summary` (object): `{feature_count, geometry_types, source,
  osm_timestamp, query_or_filter, duration_ms}`

## Tools required

- `osmium` — pbf tag-filtering + export (`osmium tags-filter`, `osmium export`)
- `http` — Overpass API queries (allowlisted endpoints only)

## Execution plan

1. Validate bbox and tag filter; estimate result size (bbox area x tag class
   heuristic) and pick/confirm the source route
2. Overpass route: build an Overpass QL query from `tags` + bbox with
   `out geom;`, POST it with a 180 s server-side timeout, honor retry-after
3. PBF route: `osmium extract --bbox` then `osmium tags-filter` with the tag
   expression, then `osmium export` to GeoJSON
4. Normalize: convert to the requested format via GDAL, flatten selected tags
   to columns, keep the remainder in an `other_tags` field
5. Count features per geometry type; capture the data timestamp (Overpass
   `osm3s.timestamp_osm_base` or pbf header)
6. Return output path + summary with concrete counts

## LLM prompts

### Build a tag filter from a feature description (workhorse tier)

System: You translate feature descriptions into OSM tag filters. Output JSON
only: {"tags": {key: value|[values]|"*"}}. Use standard OSM tagging (highway,
building, amenity, landuse, natural, waterway). Prefer specific values over
wildcards when the request is specific.

User: Request: {user_request}. AOI: {aoi_description}.

## Failure modes

- Overpass 429/504 (rate limit / timeout) → wait per Retry-After, retry once;
  on second failure, automatically fall back to `pbf` if `pbf_path` is
  configured, else fail recommending a pbf snapshot
- Query returns 0 features → verify the tag key exists in the taginfo of the
  area (quick count query); report whether the AOI is empty or the tag is wrong
- pbf does not cover the bbox → osmium extract yields empty; compare pbf header
  bbox with the request and name the correct regional extract to download
- Result exceeds 2 GB GeoJSON → switch output to GeoPackage automatically and
  note it in the summary

## Cost + timeout

- Max cost per invocation: $0.08
- Max duration: 300 seconds
- Typical actual cost: $0.04, typical duration: 10-120 seconds
