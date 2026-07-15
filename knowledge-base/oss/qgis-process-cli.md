---
title: qgis_process CLI
category: oss
topic_tags: [qgis, qgis-process, cli, headless, batch-processing]
status: stub
---

# qgis_process CLI

`qgis_process` is the headless command-line entry point to the QGIS Processing framework — run any of the 400+ algorithms or saved models without opening the GUI, making it the natural way to containerize QGIS geoprocessing. `qgis_process list` enumerates algorithms; `qgis_process help native:buffer` prints parameter docs. Execute with key=value pairs: `qgis_process run native:buffer -- INPUT=/data/roads.gpkg DISTANCE=50 OUTPUT=/data/roads_buf.gpkg`, or feed complex parameters as JSON on stdin: `echo '{"inputs":{"INPUT":"...","DISTANCE":50}}' | qgis_process run native:buffer -` (JSON mode also returns structured results, and `--json` formats all output as JSON for machine parsing). Saved Model Designer models run the same way: `qgis_process run /models/site_screening.model3 -- ...`, which is how desktop-authored workflows become scriptable pipeline steps. Useful flags: `--project-path` to load algorithms that need project context, `--distance-units`/`--area-units`, and `ELLIPSOID`/`CRS` parameters where algorithms accept them. In Docker, the `qgis/qgis` image ships the binary; set `QT_QPA_PLATFORM=offscreen` and a writable `XDG_RUNTIME_DIR` to avoid display errors. Exit codes are nonzero on algorithm failure, so it composes cleanly with shell pipelines, Makefiles, and Dymaxion skill executors. Compared to standalone PyQGIS scripts, `qgis_process` avoids interpreter-bootstrapping pitfalls at the cost of less in-process control.

TODO: expand from authoritative source (docs.qgis.org — qgis_process section of the User Guide).
