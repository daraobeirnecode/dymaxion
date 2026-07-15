---
title: Geographic vs Projected Coordinate Systems
category: coordinate-systems
topic_tags: [geographic, projected, geodesy, geometry, geography, measurement]
status: stub
---

# Geographic vs Projected Coordinate Systems

A geographic CRS (e.g. EPSG:4326, EPSG:4269) expresses positions as angular lat/lon on an ellipsoid; a projected CRS (e.g. EPSG:26910, EPSG:2226) maps those angles onto a plane in linear units (meters or US survey feet). Planar functions like PostGIS `ST_Area`, `ST_Distance`, and `ST_Buffer` on a geographic CRS return answers in "square degrees" or degree distances, which are meaningless — a classic bug in area calculations. Use a projected CRS for local measurement, or PostGIS's `geography` type (or `ST_DistanceSphere`/`ST_DistanceSpheroid`) which computes geodesics on the WGS84 spheroid at some CPU cost and with a reduced function set. One degree of longitude shrinks with latitude (cos φ · ~111.32 km), so degree-based tolerances behave differently in Sacramento (~38.5°N) than at the equator. Web APIs and interchange formats (GeoJSON per RFC 7946, GPS, most REST APIs) standardize on geographic WGS84, while analysis and cartography usually want projected coordinates — plan the transform boundary deliberately. arcpy exposes the same distinction via `SpatialReference.type` ("Geographic" vs "Projected") and geodesic options on tools like `Buffer_analysis(method="GEODESIC")`. Rule of thumb: store and exchange in geographic, measure and buffer in an appropriate projected CRS or with geodesic functions.

TODO: expand from authoritative source (PostGIS manual geometry vs geography chapter, postgis.net/docs; Esri projection basics documentation).
