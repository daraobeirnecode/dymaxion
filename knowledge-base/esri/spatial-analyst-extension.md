---
title: Spatial Analyst Extension — Raster Analytics
category: esri
topic_tags: [spatial-analyst, raster, map-algebra, arcpy-sa, interpolation, hydrology]
status: stub
---

# Spatial Analyst Extension — Raster Analytics

Covers the Spatial Analyst extension, Esri's core raster analysis license, exposed in Python as `arcpy.sa` (checked out via `arcpy.CheckOutExtension("Spatial")`). Map algebra works directly on `Raster` objects: `out = (Raster("dem") > 300) & (Raster("slope_pct") < 10)` composes lazily and persists with `out.save(path)`. Tool families: surface analysis (`Slope`, `Aspect`, `Hillshade`, `Curvature`, `Viewshed2`, `CutFill`), distance (`DistanceAccumulation`/`DistanceAllocation`, the modern replacements for EucDistance/CostDistance, plus `OptimalPathAsLine`), hydrology (`Fill`, `FlowDirection`, `FlowAccumulation`, `Watershed`, `StreamOrder`), interpolation (`Idw`, `Kriging`, `EmpiricalBayesianKriging` in Geostatistical Analyst, `Spline`, `NaturalNeighbor`, `TopoToRaster`), and zonal/local/focal statistics (`ZonalStatisticsAsTable(in_zone_data, zone_field, in_value_raster, out_table, statistics_type="MEAN")`, `FocalStatistics` with `NbrCircle`, `CellStatistics`). Also reclassification (`Reclassify`, `RemapRange`/`RemapValue`), conditional logic (`Con`, `SetNull`, `IsNull`), density (`KernelDensity`, `PointDensity`), and multivariate/suitability tooling (`WeightedOverlay`, `LocateRegions`, the Suitability Modeler). Environment discipline is critical: set `cellSize`, `snapRaster`, `mask`, and `extent` before chains to avoid misaligned outputs. Requires the Spatial Analyst license per session; ERROR 000824 means the checkout failed.

TODO: expand from authoritative source (pro.arcgis.com Spatial Analyst toolbox and arcpy.sa module reference).
