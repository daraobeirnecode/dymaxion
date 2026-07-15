---
title: PostGIS Query Performance Patterns
category: oss
topic_tags: [postgis, performance, query-tuning, spatial-join, optimization]
status: stub
---

# PostGIS Query Performance Patterns

The cardinal rule: filter with an index-backed predicate first (`ST_Intersects`, `ST_DWithin`, `&&`), then apply expensive exact tests — PostGIS predicates already embed the bbox shortcut, so `ST_Intersects(a.geom, b.geom)` is both the index filter and the exact test. Avoid `ST_Distance(a, b) < x` (no index) in favor of `ST_DWithin(a, b, x)`; avoid `ST_Buffer` + `ST_Intersects` for proximity queries for the same reason. Monster polygons (coastlines, county boundaries) kill join performance — pre-split them with `ST_Subdivide(geom, 256)` into a work table so each piece has a tight bbox. KNN queries use the ordering operator: `ORDER BY geom <-> ST_SetSRID(ST_MakePoint(-121.49, 38.58), 4326) LIMIT 10` walks the GIST index directly. Use `ST_SimplifyPreserveTopology` or `ST_SnapToGrid` to shed vertices before rendering or export, and `ST_AsMVT`/`ST_AsMVTGeom` for tile generation server-side. `EXPLAIN (ANALYZE, BUFFERS)` reveals whether the GIST index is used and how many heap blocks are touched. Tune `work_mem` (spatial joins spill to disk quickly) and `shared_buffers`, and parallelize big scans — PostGIS 3+ marks most functions PARALLEL SAFE. Materialize repeated expensive computations (unioned service areas, transformed geometries) into indexed tables rather than recomputing per query.

TODO: expand from authoritative source (postgis.net/docs performance tips and postgis.net/workshops — Performance section).
