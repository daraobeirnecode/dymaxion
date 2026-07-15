---
title: arcpy.da Data Access Module — SearchCursor, UpdateCursor, InsertCursor
category: esri
topic_tags: [arcpy, arcpy-da, cursors, searchcursor, updatecursor, insertcursor]
status: stub
---

# arcpy.da Data Access Module — SearchCursor, UpdateCursor, InsertCursor

Covers the modern data access API that replaced legacy `arcpy.SearchCursor` and is roughly 10x faster. `arcpy.da.SearchCursor(in_table, field_names, where_clause=None, spatial_reference=None, sql_clause=(prefix, postfix))` yields tuples in field order — use it in a `with` block or `del` the cursor to release locks; `field_names` accepts tokens like `OID@`, `SHAPE@` (full geometry object), `SHAPE@XY`, `SHAPE@AREA`, `SHAPE@LENGTH`, `SHAPE@WKT`, and `SHAPE@JSON`. `UpdateCursor` adds `updateRow(row)` and `deleteRow()`; `InsertCursor` exposes `insertRow(tuple)`. The `sql_clause` parameter enables `("DISTINCT ...", "ORDER BY ...")` where the workspace supports it (geodatabases, not shapefiles). Editing feature services, versioned data, or datasets with attribute rules/editor tracking requires wrapping cursors in an `arcpy.da.Edit(workspace)` edit session (`startEditing`/`startOperation` or the context-manager form). Also covers `arcpy.da.Walk` for workspace crawling (the GIS-aware `os.walk`), `arcpy.da.Describe` returning a dict, `FeatureClassToNumPyArray`/`TableToNumPyArray` and `NumPyArrayToFeatureClass` for pandas/NumPy interop, and `arcpy.da.ListDomains`. Common idioms: dict-based joins built from a SearchCursor instead of AddJoin, and updating only rows matched by `where_clause` to minimize lock scope.

TODO: expand from authoritative source (pro.arcgis.com arcpy.da module reference).
