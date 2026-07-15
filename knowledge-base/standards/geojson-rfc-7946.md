---
title: GeoJSON (RFC 7946)
category: standards
topic_tags: [geojson, rfc-7946, json, wgs84, encoding, features]
status: stub
---

# GeoJSON (RFC 7946)

GeoJSON, standardized as IETF RFC 7946 (2016, obsoleting the informal 2008 spec), defines nine object types: seven geometries (Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection) plus Feature (geometry + `properties`) and FeatureCollection. Its strictest and most-violated rule: coordinates are always [longitude, latitude(, elevation)] in WGS84 (CRS84) — RFC 7946 removed the old `crs` member entirely, so "GeoJSON in State Plane" is not GeoJSON, and axis-swapped output is the ecosystem's most common bug. Polygon rings follow the right-hand rule (exterior counterclockwise, holes clockwise) per §3.1.6, though parsers are told to be tolerant; lines crossing the antimeridian should be cut into MultiLineStrings (§3.1.9), and `bbox` members are optional [west, south, east, north] arrays. The media type is `application/geo+json`. Everything speaks it: PostGIS `ST_AsGeoJSON` (with a feature-level variant taking a record), GDAL's GeoJSON driver (plus newline-delimited GeoJSONSeq for streaming), shapely/geopandas (`__geo_interface__`), MapLibre/Leaflet sources, and OGC API Features uses it as the default encoding; Esri JSON is a different dialect (rings, `spatialReference`) that the ArcGIS REST API's `f=geojson` parameter or `arcgis2geojson` converts. Precision guidance from the RFC: ~7 decimal places ≈ 1 cm — publishing 15-digit coordinates just bloats payloads. GeoJSON has no schema for properties and no topology (shared boundaries duplicate coordinates — TopoJSON addresses that); large files parse as one JSON document, so beyond tens of MB switch to GeoJSONSeq, FlatGeobuf, or GeoParquet. It remains the unchallenged interchange format for web APIs and the correct default output for any Dymaxion feature-returning endpoint.

TODO: expand from authoritative source (IETF RFC 7946, datatracker.ietf.org/doc/html/rfc7946).
