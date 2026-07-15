---
title: QGIS Processing Algorithms
category: oss
topic_tags: [qgis, processing, geoprocessing, algorithms, automation]
status: stub
---

# QGIS Processing Algorithms

The QGIS Processing framework exposes 400+ geoprocessing algorithms from multiple providers — `native:` (C++ core, e.g. `native:buffer`, `native:joinattributesbylocation`, `native:dissolve`, `native:clip`), `qgis:` (Python-based), plus wrapped GDAL (`gdal:warpreproject`, `gdal:rasterize`), GRASS (`grass7:v.clean`, `r.watershed`), and SAGA algorithms. Invoke programmatically with `processing.run('native:buffer', {'INPUT': layer, 'DISTANCE': 100, 'SEGMENTS': 8, 'DISSOLVE': True, 'OUTPUT': 'memory:'})`, which returns a dict whose `'OUTPUT'` key holds the result layer or path; `processing.runAndLoadResults` also adds it to the project. Discover algorithms and their parameters with `QgsApplication.processingRegistry().algorithms()` and `processing.algorithmHelp('native:buffer')`. The graphical Model Designer chains algorithms into reusable models (saved as .model3) that themselves become algorithms, and "Batch Process" runs one algorithm over many inputs. Custom algorithms subclass `QgsProcessingAlgorithm` with typed parameter/output declarations, giving automatic GUI, batch, and CLI support. Outputs support `'TEMPORARY_OUTPUT'`, `'memory:'` scratch layers, file paths, and direct PostGIS writes. Feedback objects (`QgsProcessingFeedback`) stream progress and allow cancellation — important for long-running headless jobs. Everything here is also callable without the GUI via standalone PyQGIS or the `qgis_process` CLI, which is how server-side Dymaxion skills should wrap QGIS analysis.

TODO: expand from authoritative source (docs.qgis.org — Processing providers and algorithms reference).
