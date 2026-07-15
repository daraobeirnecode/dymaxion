---
title: Custom Projections and PROJ Strings
category: coordinate-systems
topic_tags: [proj, proj4, wkt2, custom-projection, pipelines, srid]
status: stub
---

# Custom Projections and PROJ Strings

When no EPSG code fits — a project-local grid, a low-distortion projection for a corridor, an old client CRS — you define a custom CRS with a PROJ string or, preferably, WKT2 (ISO 19162:2019). A PROJ string composes parameters like `+proj=aea +lat_1=34 +lat_2=40.5 +lat_0=0 +lon_0=-120 +x_0=0 +y_0=-4000000 +datum=NAD83 +units=m` (that example is EPSG:3310, California Albers). Since PROJ 6+, plain proj4 strings lose datum metadata ("proj4 string lossiness"), so WKT2 via `projinfo -o WKT2:2019 EPSG:3310` is the durable representation; avoid `+towgs84` in new work. PROJ pipelines (`+proj=pipeline +step ...`) express explicit multi-step transformations, including grid shifts, and can be tested with `cct` and `cs2cs` on the command line. To register a custom CRS in PostGIS, insert a row into `spatial_ref_sys` with an SRID in the user range (32768–898999 by convention, commonly 9xxxxx), supplying both `proj4text` and `srtext`; GeoServer accepts additions via `user_projections/epsg.properties`, and arcpy builds one from WKT with `arcpy.SpatialReference(text=wkt)`. Common custom cases: Transverse Mercator with a project-centered `+lon_0` and scale factor `+k_0=1.0000xx` for pipeline/rail corridors, and oblique Mercator (`+proj=omerc`) for slanted coastlines. Always round-trip test a custom CRS: project known control points and compare against surveyed values before committing data.

TODO: expand from authoritative source (PROJ documentation at proj.org, especially projinfo/cct/pipeline chapters; OGC WKT2 spec 18-010r7).
