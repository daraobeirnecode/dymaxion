---
title: PyQGIS Desktop Scripting
category: oss
topic_tags: [pyqgis, qgis, python, automation, scripting]
status: stub
---

# PyQGIS Desktop Scripting

PyQGIS is the Python API over the QGIS C++ core: key classes are `QgsProject.instance()` (the open project), `QgsVectorLayer`/`QgsRasterLayer`, `QgsFeature`/`QgsGeometry`, `QgsCoordinateReferenceSystem` and `QgsCoordinateTransform`, and `iface` (the desktop GUI handle, only in-app). Load a layer with `layer = QgsVectorLayer('/data/parcels.gpkg|layername=parcels', 'Parcels', 'ogr')` or a PostGIS layer via `QgsDataSourceUri` with `uri.setConnection(host, port, db, user, pwd)` and `uri.setDataSource('public', 'parcels', 'geom')`. Iterate features with `layer.getFeatures(QgsFeatureRequest().setFilterExpression('"zone" = \'R1\''))`, and edit inside `with edit(layer):` blocks that wrap commits/rollbacks. Standalone scripts (outside the GUI) must bootstrap: `QgsApplication.setPrefixPath('/usr', True); qgs = QgsApplication([], False); qgs.initQgis()` — and call `qgs.exitQgis()` at the end; processing needs `from processing.core.Processing import Processing; Processing.initialize()`. The expression engine (`QgsExpression`) and the Processing framework (`processing.run(...)`) are both reachable from PyQGIS, making it the glue for headless batch cartography, layout PDF export via `QgsLayoutExporter`, and bulk symbology changes. The in-app Python console and its editor are the fastest way to prototype; snippets promote naturally into Processing scripts or plugins. Match the system Python to the QGIS build (qgis.org packages bundle their own) — mixing interpreter versions is the top standalone-script failure mode.

TODO: expand from authoritative source (docs.qgis.org — PyQGIS Developer Cookbook).
