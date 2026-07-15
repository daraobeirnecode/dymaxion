---
title: arcpy.management Module Reference
category: esri
topic_tags: [arcpy, management, createfeatureclass, addfield, calculatefield, append]
status: stub
---

# arcpy.management Module Reference

Summarizes the Data Management toolbox as exposed through `arcpy.management.*`, the workhorse module for schema and data maintenance. Core schema tools: `CreateFeatureclass(out_path, out_name, geometry_type, template, spatial_reference)`, `CreateFileGDB`, `CreateTable`, `AddField(in_table, field_name, field_type, field_length=...)`, `DeleteField`, `AlterField`, and `AddIndex`. Data movement: `Append(inputs, target, schema_type="TEST"|"NO_TEST", field_mapping=...)`, `CopyFeatures`, `Merge`, and `Delete` (which removes datasets and also releases schema locks held by the reference). Attribute work: `CalculateField(in_table, field, expression, expression_type="PYTHON3")` and `CalculateGeometryAttributes` for length/area/coordinates. Selection and layer tools used in scripts: `MakeFeatureLayer`, `SelectLayerByAttribute(layer, "NEW_SELECTION", where_clause)`, `SelectLayerByLocation(layer, "INTERSECT", select_features)`, and `GetCount` (returns a Result object — cast with `int(result[0])`). Also covers projection tools `Project` and `DefineProjection` (and the classic mistake of using DefineProjection when Project is needed), `AddSpatialIndex`, `Rename`, and domain/subtype tools (`CreateDomain`, `AddCodedValueToDomain`, `AssignDomainToField`). Notes that every tool returns a `Result` object and messages are retrievable via `arcpy.GetMessages()`.

TODO: expand from authoritative source (pro.arcgis.com Data Management toolbox arcpy tool reference).
