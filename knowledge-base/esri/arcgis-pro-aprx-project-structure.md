---
title: ArcGIS Pro Project (.aprx) Structure
category: esri
topic_tags: [arcgis-pro, aprx, maps, layouts, toolboxes, arcpy-mp]
status: stub
---

# ArcGIS Pro Project (.aprx) Structure

Explains what lives inside an ArcGIS Pro project and how to automate it. An .aprx is a single project file containing maps, scenes, layouts, tasks, connections (databases, servers, folders), styles, and references to toolboxes — unlike ArcMap's .mxd, one project holds many maps and layouts. Each project is created with a default file geodatabase (its default workspace) and a default toolbox (.atbx, formerly .tbx); the home folder anchors relative paths. Layer symbology and properties can be exported as .lyrx (JSON-based layer files), and maps as .mapx / layouts as .pagx for portable exchange. Programmatic access goes through `arcpy.mp`: `arcpy.mp.ArcGISProject(r"path\to\proj.aprx")` (or `"CURRENT"` inside Pro), then `.listMaps()`, `map.listLayers()`, `.listLayouts()`, `layout.exportToPDF()`, and `aprx.save()` / `saveACopy()`. Also covers project packaging (.ppkx project package and .aptx project template) for sharing entire projects with data, and the tasks (.esriTasks) feature for guided workflows. Notes the gotcha that .aprx files are not backward compatible across Pro major versions and that `arcpy.mp` replaced `arcpy.mapping` from ArcMap.

TODO: expand from authoritative source (pro.arcgis.com "Projects in ArcGIS Pro" and arcpy.mp module reference).
