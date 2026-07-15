---
title: ModelBuilder and Python Toolbox Authoring
category: esri
topic_tags: [modelbuilder, python-toolbox, pyt, script-tool, geoprocessing, automation]
status: stub
---

# ModelBuilder and Python Toolbox Authoring

Covers the three ways to author custom geoprocessing tools in ArcGIS Pro. ModelBuilder chains existing tools visually inside a toolbox (.atbx): supports iterators (Iterate Feature Classes, Iterate Row Selection), inline variable substitution (`%name%`), preconditions, and the Calculate Value utility; models can be exported to Python but the export is lossy for iterators. Script tools wrap a standalone .py in a toolbox with a parameter form defined in the tool properties, reading inputs via `arcpy.GetParameterAsText(i)` and writing outputs with `arcpy.SetParameter`. Python toolboxes (.pyt) define everything in code: a `Toolbox` class plus `Tool` classes implementing `getParameterInfo()` (returning `arcpy.Parameter` objects with `datatype`, `direction`, `parameterType`), `updateParameters()` for dynamic form behavior, `updateMessages()` for validation, and `execute(parameters, messages)`. Explains when to choose each: models for analyst-maintainable chains, .pyt for version-controllable, testable tooling — .pyt files are plain text and diff cleanly in git, unlike binary .atbx. Covers `arcpy.AddMessage`/`AddWarning`/`AddError` for progress reporting, `arcpy.ImportToolbox` to call custom tools from scripts, and packaging tools for sharing as geoprocessing packages (.gpkx) or web tools on Enterprise.

TODO: expand from authoritative source (pro.arcgis.com "Creating a new Python toolbox" and ModelBuilder documentation).
