---
title: EPSG Codes Reference
category: coordinate-systems
topic_tags: [epsg, srid, crs, wgs84, web-mercator, state-plane]
status: stub
---

# EPSG Codes Reference

The EPSG registry (epsg.org, maintained by IOGP) assigns numeric identifiers to coordinate reference systems, datums, and transformations; PostGIS stores these in `spatial_ref_sys` and exposes them via `ST_SRID`/`ST_SetSRID`/`ST_Transform`. EPSG:4326 is geographic WGS84 (lat/lon degrees), the default for GeoJSON and GPS output. EPSG:3857 is WGS84 / Pseudo-Mercator (Web Mercator), the tiling scheme used by Google Maps, ArcGIS Online basemaps, and MapLibre. EPSG:4269 is geographic NAD83, the parent of the US State Plane and UTM NAD83 families. EPSG:26910 is NAD83 / UTM zone 10N (meters), covering coastal California including Sacramento; EPSG:26911 is zone 11N for eastern California and Nevada. State Plane California Zone II is EPSG:2226 (NAD83, US survey feet) and Zone III is EPSG:2227 — most Sacramento-region agency data ships in one of these. EPSG:3310 is NAD83 / California Albers, the standard statewide equal-area CRS used by CAL FIRE and CDFW. EPSG:3763 is ETRS89 / Portugal TM06, an example of a national transverse Mercator grid. Axis order is a recurring trap: EPSG:4326 is formally lat,lon but GeoJSON and most software use lon,lat, so always check `OAMS_TRADITIONAL_GIS_ORDER` behavior in GDAL/PROJ.

TODO: expand from authoritative source (EPSG Geodetic Parameter Dataset at epsg.org; PROJ documentation at proj.org).
