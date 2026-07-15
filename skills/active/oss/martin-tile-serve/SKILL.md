---
slug: martin-tile-serve
name: Martin Tile Serve
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Martin Tile Serve

## Purpose

Register a PostGIS table as an MVT (Mapbox Vector Tile) source in the Martin
tile server: edit Martin's YAML config, reload the service, and verify tiles
render. Destructive because it rewrites service configuration and changes what
the tile endpoint serves — approval required.

## When to use this skill

- A web map (MapLibre/Deck.gl) needs vector tiles from a PostGIS table
- Adjusting zoom range, extent, or properties of an already-served table
- Standing up tiles for a table just created by `postgis-schema-migrate` /
  loaded by `gdal-format-convert`

## When NOT to use this skill

- OGC WMS/WFS is required (desktop clients, standards mandate) — use
  `geoserver-publish`
- One-off static tiles from a file — generate a PMTiles archive instead (no
  server config change needed)
- The table has no spatial index or SRID — fix via `postgis-schema-migrate`
  first; Martin will serve it slowly or not at all

## Inputs

- `table` (string, required): schema-qualified table, e.g. `public.parcels`
- `connection` (string, required): Postgres connection string or named
  connection Martin should use
- `config_path` (string, optional, default `/workspace/config/martin.yaml`):
  Martin YAML config file to edit
- `tile_options` (object, optional): `{minzoom, maxzoom, extent, buffer,
  properties: [...]}` overrides for the source entry

## Outputs

- `tile_endpoint` (string): tile URL template, e.g.
  `http://martin:3000/public.parcels/{z}/{x}/{y}`
- `config_path` (string): path of the updated Martin config

## Tools required

- `filesystem-mcp` — read/patch the Martin YAML config (with backup)
- `http` — Martin health check, catalog endpoint, tile fetch verification

## Execution plan

1. Verify the table exists, has a geometry column with a declared SRID, and has
   a GIST index (query via the connection); warn hard if the index is missing
2. Read the current Martin config; determine whether the table is already
   served (update vs add)
3. Raise approval request showing the exact YAML diff to be applied
4. Back up the config, apply the new/updated source entry with `tile_options`
5. Reload Martin (SIGHUP or container restart per deployment) and poll
   `/health` until ready (max 60 s)
6. Verify: `/catalog` lists the source; fetch one mid-zoom tile covering the
   table's extent and confirm HTTP 200 with non-empty MVT body
7. Return `tile_endpoint` + `config_path`

## LLM prompts

### Choose tile options from table characteristics (workhorse tier)

System: You configure a Martin MVT source. Output JSON only: {"minzoom": n,
"maxzoom": n, "properties": [...]}. Pick zooms from geometry type and feature
density (points can start higher; dense polygons need lower maxzoom plus
simplification). Include only attributes useful for styling/popups.

User: Table: {table}. Geometry type: {geom_type}. Feature count: {count}.
Extent: {bbox}. Columns: {columns}. Intended map use: {use_case}.

## Failure modes

- Martin fails to reload with the new config → restore the backup config,
  reload again, report the YAML validation error; endpoint keeps serving the
  old catalog
- Verification tile returns 204/empty at the chosen zoom → widen the probe to
  the table extent centroid at minzoom; if still empty, report SRID/extent
  mismatch between the table and Web Mercator
- Table lacks a GIST index → proceed only if the operator approved despite the
  warning; record expected latency impact in the run log
- Connection string rejected by Martin → never echo credentials; report the
  sanitized host/db and point at the SOPS env entry

## Cost + timeout

- Max cost per invocation: $0.10
- Max duration: 300 seconds
- Typical actual cost: $0.05, typical duration: 15-60 seconds
