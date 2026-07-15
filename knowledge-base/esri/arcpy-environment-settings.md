---
title: arcpy Environment Settings (arcpy.env)
category: esri
topic_tags: [arcpy, environment, workspace, overwriteoutput, parallel-processing, scratchgdb]
status: stub
---

# arcpy Environment Settings (arcpy.env)

Reference for controlling geoprocessing behavior from Python via `arcpy.env`. Foundational settings: `arcpy.env.workspace` (default path for tools and List functions like `ListFeatureClasses`), `arcpy.env.scratchWorkspace` plus the read-only derived `arcpy.env.scratchGDB`/`scratchFolder` (guaranteed-writable temp locations, key for services and notebooks), and `arcpy.env.overwriteOutput = True` (without it any existing output raises ERROR 000258/000725). Spatial control: `outputCoordinateSystem` (accepts `arcpy.SpatialReference(3857)` or WKID), `extent`, `XYTolerance`, `XYResolution`, and `geographicTransformations` for datum shifts. Performance: `parallelProcessingFactor = "100%"` (honored by pairwise and many raster tools), `autoCommit` for enterprise geodatabase edit batching, and `compression`/`pyramid`/`rasterStatistics` for raster outputs. Raster alignment: `cellSize`, `snapRaster`, and `mask` must be set together for reliable Spatial Analyst chains. Scoping patterns: `with arcpy.EnvManager(workspace=gdb, extent=aoi):` applies settings temporarily, `arcpy.ClearEnvironment("extent")` resets one, and `arcpy.ResetEnvironments()` resets all. Gotchas: environments persist for the Python session (a leftover `extent` silently clips later tools), server/web tools ignore some environments, and `addOutputsToMap = False` speeds up scripts run inside Pro.

TODO: expand from authoritative source (pro.arcgis.com "arcpy.env" environment settings reference).
