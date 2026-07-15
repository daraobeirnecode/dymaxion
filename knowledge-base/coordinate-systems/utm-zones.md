---
title: UTM Zones
category: coordinate-systems
topic_tags: [utm, transverse-mercator, zones, epsg-26910, grid]
status: stub
---

# UTM Zones

Universal Transverse Mercator divides the world into 60 north–south zones, each 6° of longitude wide, numbered eastward from zone 1 at 180°W; zone number = floor((lon + 180)/6) + 1. Each zone is a secant Transverse Mercator (`+proj=utm +zone=NN`) with central-meridian scale factor k₀ = 0.9996, false easting 500,000 m, and (southern hemisphere only) false northing 10,000,000 m; coverage runs 84°N to 80°S, with UPS handling the poles. EPSG numbering is systematic: WGS84 zones are 326xx north / 327xx south (EPSG:32610 = WGS84 UTM 10N), and NAD83 zones are 269xx (EPSG:26910 = NAD83 UTM 10N, covering Sacramento and coastal California; EPSG:26911 = 11N). Distortion stays within about 1 part in 2,500 inside a zone, making UTM a solid default for regional analysis in meters — but accuracy degrades fast past the zone edge, and datasets spanning a zone boundary (the −120° line splits California) should move to a statewide CRS like EPSG:3310 instead of stitching zones. Never mix coordinates from two zones in one geometry column; PostGIS will not warn because the SRID is per-column. MGRS and the military grid extend UTM with lettered 100 km squares, and the lettered "latitude bands" (C–X) in designators like 10S are MGRS bands, not hemisphere flags — a common parsing bug. GDAL selects UTM automatically via `EPSG:326{zone}` in `gdalwarp -t_srs`, and `ST_Transform(geom, 26910)` is the typical Sacramento-area measurement idiom.

TODO: expand from authoritative source (NGA UTM/MGRS specification; EPSG registry UTM entries; proj.org utm projection page).
