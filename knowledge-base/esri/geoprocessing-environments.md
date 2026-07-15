---
title: Geoprocessing Environments in ArcGIS Pro
category: esri
topic_tags: [geoprocessing, environments, workspace, extent, snap-raster, parallel-processing]
status: stub
---

# Geoprocessing Environments in ArcGIS Pro

Explains geoprocessing environment settings — hidden parameters that alter tool behavior at four levels: application, tool, model/script, and per-tool-call. Key environments include `workspace` and `scratchWorkspace` (default input/output locations), `outputCoordinateSystem` (reprojects outputs on the fly), `extent` (limits processing to a bounding box), `overwriteOutput` (allow replacing existing outputs), `parallelProcessingFactor` (e.g. `"100%"` to use all cores for tools that honor it), and `XYTolerance`/`XYResolution`. Raster-focused environments — `cellSize`, `snapRaster`, `mask`, `compression`, `pyramid` — are critical for Spatial Analyst work where misaligned cells silently corrupt analysis. In Python, environments are set via `arcpy.env.workspace = r"C:\data\proj.gdb"` etc., and scoped temporarily with the `arcpy.EnvManager(extent=..., cellSize=...)` context manager. Covers the environment inheritance model (tool-level overrides model-level overrides application-level), which tools honor which environments (each tool reference page lists them), and gotchas like `extent` clipping features unexpectedly or a stale `scratchGDB` filling disk. Also notes `arcpy.env.addOutputsToMap` for headless scripts and `transferDomains`/`maintainAttachments` behavior on data conversion tools.

TODO: expand from authoritative source (pro.arcgis.com "Geoprocessing environment settings" reference).
