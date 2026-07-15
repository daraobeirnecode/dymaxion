---
title: arcpy.conversion Module Reference
category: esri
topic_tags: [arcpy, conversion, featurestojson, jsontofeatures, export, interchange]
status: stub
---

# arcpy.conversion Module Reference

Summarizes the Conversion toolbox (`arcpy.conversion.*`) for moving data between formats. JSON round-trips: `FeaturesToJSON(in_features, out_json, format_json="FORMATTED", geoJSON="GEOJSON")` exports Esri JSON or GeoJSON, and `JSONToFeatures(in_json, out_fc)` imports either — the primary bridge between arcpy and web/REST payloads. Tabular and vector exchange: `ExportFeatures` and `ExportTable` (Pro 3.x replacements for `FeatureClassToFeatureClass`/`TableToTable`), `FeatureClassToGeodatabase` (batch), `FeatureClassToShapefile`, `TableToExcel`/`ExcelToTable`, and `GPX To Features`. CAD and interchange: `ExportCAD`/`CADToGeodatabase` for DWG/DXF, and KML via `MapToKML`/`KMLToLayer`. Raster conversions: `RasterToPolygon(in_raster, out_fc, "SIMPLIFY", "Value")`, `PolygonToRaster`, `PointToRaster`, `FeatureToRaster`, `RasterToPoint`, and `ASCIIToRaster`. Notes the deprecation trail (Pro 3.x renamed several classic tools and moved Excel tools into conversion), shapefile export pitfalls (field-name truncation to 10 chars, date/time loss, NULL coercion), and that GeoJSON export always emits WGS84 coordinates when `geoJSON="GEOJSON"` is set. Mentions `arcpy.conversion.PDFToTIFF` and PDF export living instead under layout objects in `arcpy.mp`.

TODO: expand from authoritative source (pro.arcgis.com Conversion toolbox arcpy tool reference).
