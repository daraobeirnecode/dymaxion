---
title: PostGIS Common ST Functions
category: oss
topic_tags: [postgis, st-functions, spatial-sql, geometry, predicates]
status: stub
---

# PostGIS Common ST Functions

The workhorse spatial predicates are `ST_Intersects`, `ST_Contains`, `ST_Within`, `ST_Touches`, `ST_Crosses`, `ST_Overlaps`, and `ST_DWithin(geom_a, geom_b, distance)` — all of which can use a GIST index on either argument. Measurement functions include `ST_Distance` (planar for geometry, geodesic meters for geography), `ST_Area`, `ST_Length`, and `ST_Perimeter`. Geometry construction and editing covers `ST_Buffer(geom, radius)`, `ST_Union` (both aggregate and two-argument forms), `ST_Intersection`, `ST_Difference`, `ST_Centroid`, `ST_PointOnSurface`, `ST_Simplify`/`ST_SimplifyPreserveTopology`, and `ST_Subdivide` for breaking huge polygons into index-friendly pieces. Invalid geometries (self-intersections, unclosed rings) are repaired with `ST_MakeValid` and detected with `ST_IsValid`/`ST_IsValidReason`. Reprojection is `ST_Transform(geom, target_srid)`; SRID assignment without reprojection is `ST_SetSRID`. Input/output converters include `ST_GeomFromText`, `ST_GeomFromGeoJSON`, `ST_AsGeoJSON`, `ST_AsText`, `ST_AsBinary`, and `ST_AsMVTGeom` for vector tiles. Prefer `ST_DWithin` over `ST_Distance(...) < x` in WHERE clauses because only the former is index-accelerated. Casting between `geometry` and `geography` (`geom::geography`) switches distance math from planar units to meters on the spheroid.

TODO: expand from authoritative source (postgis.net/docs — PostGIS Reference, Spatial Relationships and Measurements).
