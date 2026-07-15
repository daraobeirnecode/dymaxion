---
title: "Datum Shifts: NAD27 to NAD83 to WGS84"
category: coordinate-systems
topic_tags: [datum, nad27, nad83, wgs84, transformation, ntv2]
status: stub
---

# Datum Shifts: NAD27 to NAD83 to WGS84

NAD27 (Clarke 1866 ellipsoid, Meades Ranch origin) differs from NAD83 (GRS80 ellipsoid, geocentric) by up to ~100 m horizontally in the conterminous US, so legacy quad sheets and old parcel fabrics must be grid-shifted, not just re-declared. The canonical NAD27→NAD83 transformation is NADCON (and NTv2-format grids in PROJ, e.g. `@conus.gsb` / `us_noaa_conus.tif` via the PROJ CDN); simple three-parameter Helmert shifts are not accurate enough. NAD83 has realizations — NAD83(1986), NAD83(HARN), NAD83(CORS96), NAD83(2011) epoch 2010.0 — that differ by decimeters; EPSG:6318 is geographic NAD83(2011). NAD83 and WGS84 (G1762/G2139 realizations) currently diverge by roughly 1.5–2 m in CONUS because NAD83 is plate-fixed while WGS84 is earth-centered; the common "NAD83 = WGS84" zero shift (EPSG:1188-style null transformation) silently absorbs that error. For sub-meter work use time-dependent transformations (e.g. EPSG:1946 family, HTDP) that account for plate motion and epoch. In PROJ, inspect candidate pipelines with `projinfo -s EPSG:4267 -t EPSG:4326 --spatial-test intersects` and pick by accuracy field; in arcpy, set `geographic_transformations` explicitly (e.g. `NAD_1927_To_NAD_1983_NADCON` then `WGS_1984_(ITRF00)_To_NAD_1983`). NOAA's planned NATRF2022 will replace NAD83 entirely, so record datum + epoch in dataset metadata now.

TODO: expand from authoritative source (NOAA NGS datum documentation; PROJ transformation grids documentation at proj.org).
