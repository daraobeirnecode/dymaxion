---
title: "ETL: Delta Materialization for Tile Refresh"
category: workflow-patterns
topic_tags: [tiles, delta, materialization, dirty-tiles, refresh, mvt]
status: stub
---

# ETL: Delta Materialization for Tile Refresh

Regenerating a full tile pyramid after every data change is wasteful — zoom 0–14 over a county is hundreds of thousands of tiles when a nightly load usually touches a few hundred features. Delta materialization computes the changed area first: collect edited/deleted geometries (old and new shapes both), union their bounding boxes, and expand each affected tile coordinate via slippy-map math (tile x = floor((lon+180)/360 · 2^z), plus a 1-tile buffer for features rendered across tile edges). Enumerate "dirty tiles" per zoom from those envelopes and re-render only that set — with `ST_AsMVT`/`ST_TileEnvelope` in PostGIS, tippecanoe on an extract, or GeoWebCache/CompactCache seeding restricted to a bounding geometry. GeoWebCache exposes this directly as truncate-by-bbox on a layer; Esri's `Manage Map Server Cache Tiles` accepts an area-of-interest feature class for partial rebuilds. Keep a `tile_dirty` queue table (z, x, y, layer, dirtied_at) written by the silver→gold step in the same transaction as the data change, so the tiler can drain it asynchronously and idempotently. For PMTiles or MBTiles artifacts, deltas usually mean re-running tippecanoe over only the affected `-z`/`-Z` range or maintaining per-region archives that are rebuilt independently. Track refresh lag (max dirtied_at age) as the pipeline SLO; falling back to a scheduled full rebuild weekly guards against missed invalidations.

TODO: expand from authoritative source (GeoWebCache seeding/truncate REST docs; PostGIS ST_AsMVT/ST_TileEnvelope reference; tippecanoe README).
