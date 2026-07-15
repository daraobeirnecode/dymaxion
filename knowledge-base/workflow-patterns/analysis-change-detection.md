---
title: "Analysis: Change Detection Between Two Dates"
category: workflow-patterns
topic_tags: [change-detection, temporal, diff, symmetric-difference, raster, ndvi]
status: stub
---

# Analysis: Change Detection Between Two Dates

Vector change detection between two snapshots is a keyed full-outer-join problem: join epoch A to epoch B on the stable id (GlobalID/APN), then classify rows as added (B only), removed (A only), attribute-changed (ids match, attribute hash differs), or geometry-changed (`NOT ST_Equals(a.geom, b.geom)`, or Hausdorff distance `ST_HausdorffDistance` above a tolerance to ignore sub-precision jitter). Without stable ids, fall back to spatial matching — `ST_Equals` for exact, or overlap ratio `ST_Area(ST_Intersection)/ST_Area(ST_Union)` above ~0.95 for fuzzy matching — and report unmatched features honestly. Area-of-change maps come from `ST_SymDifference` (per-pair) or epoch-wide union differencing; Esri's equivalents are `arcpy.management.DetectFeatureChanges` and Feature Compare. For raster/imagery change: co-register both dates (same grid via `gdalwarp -tr -tap`), then band math — NDVI differencing for vegetation, dNBR for burn severity, simple thresholded image differencing, or classified-map cross-tabulation via a transition matrix (`gdal_calc.py`, rasterio, or `arcpy.sa.Con`). Normalize before differencing: same CRS, same resolution, comparable phenology/sun angle for imagery, identical field domains for vectors — most "detected change" in careless runs is preprocessing artifact. Precision noise is the vector trap: run `ST_ReducePrecision(geom, 0.001)` (or snap to a survey-appropriate grid) before geometry comparison. Output a change table with change_type, before/after values, and delta geometry, plus counts per class ("312 parcels changed attributes, 47 geometry, 5 removed") for the run report.

TODO: expand from authoritative source (PostGIS ST_SymDifference/ST_HausdorffDistance docs; Esri Detect Feature Changes tool; USGS dNBR change-detection methodology).
