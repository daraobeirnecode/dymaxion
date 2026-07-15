---
title: Well-Known Text (WKT) and Well-Known Binary (WKB) for Geometry
category: standards
topic_tags: [wkt, wkb, ewkb, simple-features, geometry-encoding, iso-13249]
status: stub
---

# Well-Known Text (WKT) and Well-Known Binary (WKB) for Geometry

WKT and WKB are the OGC Simple Features (SFA, ISO 19125 / SQL/MM ISO 13249-3) encodings for geometry: WKT is human-readable text like `POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))`, WKB is the equivalent byte stream — a byte-order flag (00 big-endian/01 little-endian), a uint32 geometry type code (1=Point, 2=LineString, 3=Polygon, 4–7 the Multi/Collection types), then coordinate doubles. Z/M dimensions extend the type codes (ISO WKB adds 1000/2000/3000 offsets; variants like `POINT Z`, `POINT ZM` in WKT), and empties are written `POLYGON EMPTY`. PostGIS speaks both plus its EWKT/EWKB extensions, which embed the SRID (`SRID=4326;POINT(-121.49 38.58)` and an SRID flag bit 0x20000000 in EWKB) — EWKB is what PostGIS emits by default from `ST_AsEWKB` and what its hex geometry display actually is; strict-spec consumers need `ST_AsBinary`/`ST_AsText` instead. Key functions across stacks: PostGIS `ST_GeomFromText`/`ST_AsText`/`ST_GeomFromWKB`, shapely `wkt.loads`/`wkb.loads`, GDAL/OGR `CreateGeometryFromWkt`, GeoPandas `to_wkb`, and arcpy `Geometry.WKT`/`WKB` properties. WKB is the workhorse interchange inside databases and columnar formats — GeoPackage BLOBs wrap it with a small GP header, and GeoParquet stores geometry as WKB columns — while WKT serves logs, tests, and quick fixtures. Do not confuse geometry WKT with CRS WKT (WKT2, ISO 19162), an entirely different grammar for coordinate reference systems that happens to share the name. Precision caveat: WKT round-trips can truncate doubles depending on formatter settings, so binary paths (WKB) are the lossless choice for pipelines.

TODO: expand from authoritative source (OGC Simple Features Access spec 06-103r4; PostGIS WKT/WKB/EWKB documentation).
