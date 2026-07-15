---
title: Web Mercator Distortion at High Latitudes
category: coordinate-systems
topic_tags: [web-mercator, epsg-3857, distortion, scale-factor, basemaps]
status: stub
---

# Web Mercator Distortion at High Latitudes

Web Mercator (EPSG:3857, "WGS84 / Pseudo-Mercator") uses a spherical Mercator formulation on WGS84 geographic coordinates, which makes it fast for tiling but non-conformal in the strict sense and unusable for measurement. Scale distortion grows as 1/cos(latitude): features are exaggerated ~1.3x in linear scale at Sacramento's ~38.5°N, 2x at 60°N, and Greenland renders visually larger than Africa despite being ~14x smaller in true area. Never compute area or distance directly in 3857 — `ST_Area` on 3857 geometry at 38.5°N overstates area by ~60% (scale factor squared); reproject to an equal-area CRS such as EPSG:3310 (California Albers) or use the `geography` type instead. The projection is clipped at ±85.0511° (where the square world tile closes), so polar data simply cannot be shown. EPSG:3857's official WKT was preceded by unofficial codes 900913 and EPSG:3785, which still appear in old configs and `spatial_ref_sys` tables. It remains the correct choice for slippy-map tile pyramids (XYZ / WMTS GoogleMapsCompatible / ArcGIS Online basemaps) because the entire ecosystem's tile matrix sets assume it. For dashboards that display measurements, the pattern is: render in 3857, measure via geodesic functions, and label the map with a scale-varies caveat at small scales.

TODO: expand from authoritative source (EPSG:3857 registry entry; Esri and OGC guidance on Web Mercator for mapping vs analysis).
