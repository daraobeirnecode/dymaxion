---
title: arcpy Common Gotchas — Schema Locks, Field Types, Unicode, Licensing
category: esri
topic_tags: [arcpy, gotchas, schema-lock, field-length, unicode, error-codes]
status: stub
---

# arcpy Common Gotchas — Schema Locks, Field Types, Unicode, Licensing

Catalog of recurring arcpy failure modes and their fixes. Schema locks: ERROR 000464 "cannot acquire a lock" appears when Pro, another process, or an undeleted cursor holds the dataset — release with `del cursor`, close attribute tables, or `arcpy.management.Delete` on stale layers; file geodatabase .lock files linger after crashes. Text field width: TEXT fields default to 255 chars and `CalculateField`/cursor writes silently truncate or raise ERROR 001156 on overflow — check `field.length` first and `AlterField` cannot widen a text field in all workspaces. Unicode/paths: always use raw strings for Windows paths (`r"C:\data"`), expect UTF-8 handling differences between shapefiles (code-page driven, .cpg files) and geodatabases (Unicode-native), and avoid non-ASCII in .gdb paths for older tools. Licensing: tools raise ERROR 000824/000816 when an extension is not checked out — call `arcpy.CheckOutExtension("Spatial")` and check `arcpy.CheckExtension` first. Other classics: `GetCount` returning a Result object not an int, tool outputs locked in-memory until `arcpy.management.Delete("memory")`, `in_memory` vs the newer `memory` workspace (no rasters or subtypes in `memory`), field name vs alias confusion, `CalculateField` expressions needing `!field!` bang syntax with `expression_type="PYTHON3"`, joins requiring `MakeFeatureLayer` first, and geometry differences where shapefile NULL geometry becomes empty geometry in a geodatabase. Includes how to read `arcpy.ExecuteError` and `arcpy.GetMessages(2)` for actual tool error text.

TODO: expand from authoritative source (pro.arcgis.com tool error reference 0001xx-series pages and Esri Community threads).
