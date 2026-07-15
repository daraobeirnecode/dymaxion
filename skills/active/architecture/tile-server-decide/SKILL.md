---
slug: tile-server-decide
name: Tile Server Decide
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Tile Server Decide

## Purpose

Recommend a tile serving strategy — pg_tileserv, Martin, TileServer GL,
GeoServer, MapTiler, or Mapbox — for a set of layers, considering layer types,
expected QPS, hosting environment, and budget. Returns an architecture doc
framed as "recommend, with tradeoffs" — never a claim of certainty.

## When to use this skill

- User asks "how should I serve tiles?" or names two tile servers to compare
- A web map project needs a tile backend and none is chosen yet
- Current tile serving is too slow/expensive and the user wants alternatives

## When NOT to use this skill

- Tile server already chosen and needs configuring (use `martin-tile-serve`
  or `geoserver-publish`)
- Question is about the database behind the tiles (use `database-choice-decide`)
- Question is about client-side rendering/styling (use `maplibre-scene-builder`)

## Inputs

- `layer_types` (array, required): layer descriptors, e.g.
  `["vector-parcels", "raster-hillshade"]`
- `expected_qps` (number, optional): expected peak tile requests per second
- `hosting_environment` (string, optional): e.g. "docker-compose on a single VM"
- `budget_constraint` (string, optional): e.g. "self-hosted, no per-request fees"

## Outputs

- `architecture_doc` (string): Markdown doc with recommendation, alternatives,
  and tradeoffs, including a static-pregeneration vs dynamic-serving call
- `recommended_tile_server` (string): one of `pg_tileserv`, `martin`,
  `tileserver-gl`, `geoserver`, `maptiler`, `mapbox`
- `tradeoffs` (array): structured tradeoff entries (`{option, pros, cons, cost_note}`)

## Tools required

- None. Pure reasoning skill — no MCP or CLI tools.

## Execution plan

1. Validate `layer_types` is a non-empty array; fail with clear error otherwise
2. Partition layers: vector (MVT-friendly), raster, mixed; note any that rule
   out vector-only servers (pg_tileserv, Martin)
3. Score the six candidates against layer mix, `expected_qps`, hosting
   environment, and budget; consider pre-generated PMTiles/MBTiles as a
   cross-cutting option for static layers
4. Call the workhorse-tier LLM with the system prompt below to draft the doc
5. Extract `recommended_tile_server` and structured `tradeoffs`
6. Return doc + structured fields; log run to `dymaxion.skill_invocations`

## LLM prompts

### Draft tile serving recommendation

System: You are a map tile infrastructure advisor. You recommend, with
tradeoffs — you never claim certainty. Distinguish clearly between
vector-only servers (pg_tileserv, Martin), full-stack servers (GeoServer,
TileServer GL), and hosted services (MapTiler, Mapbox). Always evaluate
pre-generated tiles (PMTiles/MBTiles) as an alternative to dynamic serving
when layers are static. Use the QPS and budget numbers given; state
assumptions where inputs are missing. No emoji.

User: Layers: {layer_types}. Expected peak QPS: {expected_qps}.
Hosting: {hosting_environment}. Budget: {budget_constraint}.
Produce a Markdown architecture doc with sections: Recommendation, Why,
Alternatives (with when-to-prefer), Static vs dynamic serving,
Tradeoffs table, Assumptions.

## Failure modes

- `layer_types` missing or empty → fail fast asking for layer list and types
- Layer mix contains raster but budget forces a vector-only server → recommend
  a split strategy (vector server + pre-rendered raster tiles) and flag the
  added complexity honestly
- LLM output missing a parseable server choice → retry once demanding a final
  `RECOMMENDED: <server>` line; else return
  `recommended_tile_server: "undetermined"` with the doc intact

## Cost + timeout

- Max cost per invocation: $0.40
- Max duration: 180 seconds
- Typical actual cost: $0.20, typical duration: 30 seconds
