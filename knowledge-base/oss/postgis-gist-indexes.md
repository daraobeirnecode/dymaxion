---
title: PostGIS GIST Spatial Indexes
category: oss
topic_tags: [postgis, gist, spatial-index, performance, postgres]
status: stub
---

# PostGIS GIST Spatial Indexes

Create a spatial index with `CREATE INDEX idx_parcels_geom ON parcels USING GIST (geom);` — GIST indexes the geometry's bounding box (an R-tree implemented over GIST), not the exact shape. Index-aware operators include `&&` (bbox overlap), `ST_Intersects`, `ST_DWithin`, and the KNN distance operators `<->` (centroid distance) and `<#>` (bbox distance), the latter two powering fast `ORDER BY geom <-> point LIMIT k` nearest-neighbor queries. After bulk loads run `ANALYZE tablename;` so the planner has fresh statistics, and `VACUUM ANALYZE` after heavy updates. For very large tables consider `CREATE INDEX ... WITH (fillfactor=100)` on static data, and BRIN indexes (`USING BRIN (geom)`) as a compact alternative when rows are physically clustered spatially. Clustering the heap on the index (`CLUSTER parcels USING idx_parcels_geom;`) improves cache locality for range scans. Geography columns use the same syntax: `USING GIST (geog)`. A query only uses the index if the indexed column appears bare in the predicate — wrapping it in `ST_Transform` or `ST_Buffer` defeats the index unless you build a functional index like `CREATE INDEX ON t USING GIST (ST_Transform(geom, 3857));`. Check index usage with `EXPLAIN ANALYZE` and look for "Index Scan using ... gist".

TODO: expand from authoritative source (postgis.net/docs — 4.9 Spatial Indexes, and postgis.net/workshops).
