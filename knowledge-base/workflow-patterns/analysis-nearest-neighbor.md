---
title: "Analysis: Nearest-Neighbor Queries"
category: workflow-patterns
topic_tags: [nearest-neighbor, knn, postgis, spatial-index, proximity]
status: stub
---

# Analysis: Nearest-Neighbor Queries

PostGIS answers k-nearest-neighbor queries with the index-assisted `<->` distance operator in `ORDER BY geom <-> :point LIMIT k` — since PostGIS 3 this returns true nearest neighbors via the GiST index, not just bbox-center approximations, provided the column has a GiST index. For "nearest N to each row of a table" (e.g. nearest 3 clinics to every parcel), use `CROSS JOIN LATERAL (SELECT ... ORDER BY a.geom <-> b.geom LIMIT 3)`, the canonical KNN-lateral idiom. In geographic data, cast to `geography` (`geog <-> geog` works with the geography index) or transform to a projected CRS like EPSG:26910 first — degree-space nearest neighbors are wrong away from the equator. Constrain the search with `ST_DWithin(a.geom, b.geom, :radius)` in the WHERE clause when a maximum distance exists; it prunes via the index and avoids scanning distant candidates. Equivalent tooling elsewhere: `arcpy.analysis.Near` / `GenerateNearTable`, GeoPandas `sjoin_nearest` (which uses a shapely STRtree), QGIS "Join attributes by nearest", and scikit-learn `BallTree` with haversine metric for lat/lon point sets. Straight-line nearest is often the wrong answer for street-bound questions — for "nearest by travel time" switch to a routing engine (pgRouting, Valhalla, OSRM) and the service-area pattern. Report both the neighbor and the distance (with units and CRS) so downstream consumers can sanity-check.

TODO: expand from authoritative source (PostGIS manual: KNN operators and ST_DWithin; workshops.postgis.us nearest-neighbor chapter).
