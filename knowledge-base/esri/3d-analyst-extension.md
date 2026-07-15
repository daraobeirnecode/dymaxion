---
title: 3D Analyst Extension — Surfaces, TINs, LAS, and Meshes
category: esri
topic_tags: [3d-analyst, tin, lidar, las-dataset, surface-analysis, multipatch]
status: stub
---

# 3D Analyst Extension — Surfaces, TINs, LAS, and Meshes

Covers the 3D Analyst extension (`arcpy.ddd` module, `arcpy.CheckOutExtension("3D")`) for surface and true-3D analysis. Surface data models: TINs (`CreateTin`, `EditTin`, breaklines and mass points), terrain datasets (multi-resolution TIN pyramids inside a feature dataset in a geodatabase), LAS datasets (.lasd files referencing lidar .las/.zlas tiles with class-code and return filters), and rasters/DEMs. Lidar workflows: `LasDatasetStatistics`, `ClassifyLasGround`, `ClassifyLasBuilding`, `LasPointStatsAsRaster`, and `LasDatasetToRaster` for DEM/DSM generation (binning vs triangulation interpolation, DEM from ground-classified returns, DSM from first returns). Surface analysis tools: `SurfaceVolume`, `CutFill`, `Slope`/`Aspect` (shared with Spatial Analyst), `InterpolateShape` to drape 2D features, `AddSurfaceInformation` (Z, slope, surface length attributes), line-of-sight (`ConstructSightLines`, `LineOfSight`, `Skyline`/`SkylineBarrier`) and `Viewshed`. 3D features: multipatch geometry, `ExtrudeBetween`, `Enclose Multipatch`, `Is Closed 3D`, 3D set operators (`Intersect3D`, `Union3D`, `Inside3D` — several need Advanced), and conversion to/from integrated mesh scene layers (SLPK via `CreateIntegratedMeshSceneLayerPackage`). Scene visualization context: local vs global scenes in Pro, elevation surfaces, and publishing scene layers (point cloud, 3D object, integrated mesh) to a portal. Notes overlap with Spatial Analyst (either license enables some surface tools) and with the newer reality mapping/mesh tooling.

TODO: expand from authoritative source (pro.arcgis.com 3D Analyst toolbox and arcpy.ddd reference).
