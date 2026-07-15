---
title: PostGIS SRID and Coordinate System Handling
category: oss
topic_tags: [postgis, srid, epsg, projections, st-transform]
status: stub
---

# PostGIS SRID and Coordinate System Handling

Every PostGIS geometry carries an SRID readable with `ST_SRID(geom)`; the catalog of known systems lives in the `spatial_ref_sys` table keyed by EPSG code, with `proj4text` and `srtext` (WKT) definitions. `ST_SetSRID(geom, 4326)` stamps an SRID without changing coordinates (use when data was loaded with SRID 0), while `ST_Transform(geom, 3857)` actually reprojects coordinates via PROJ. Common EPSG codes: 4326 (WGS84 lon/lat), 3857 (Web Mercator, for tiles), 26910 (NAD83 / UTM zone 10N, Northern California), 2226–2229 (California State Plane zones 2–5, US feet), and 3310 (NAD83 / California Albers, equal-area for statewide stats). Mixing SRIDs in a join raises `ERROR: Operation on mixed SRID geometries`, so normalize with `ST_Transform` inside the query or standardize at load time. Enforce a column SRID with typmod syntax: `geom geometry(MultiPolygon, 4326)`. Custom or missing CRSs can be inserted into `spatial_ref_sys` manually with a PROJ string. Distance and area in EPSG:4326 geometry are in degrees — meaningless for measurement — so either transform to a projected CRS or cast to `geography`. `Find_SRID('public','parcels','geom')` returns the declared SRID from `geometry_columns`.

TODO: expand from authoritative source (postgis.net/docs — 4.5 Spatial Reference Systems, and epsg.org).
