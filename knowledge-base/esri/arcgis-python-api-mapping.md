---
title: arcgis Python API — arcgis.mapping and Web Map Automation
category: esri
topic_tags: [arcgis-python-api, mapping, webmap, web-scene, renderers, offline-maps]
status: stub
---

# arcgis Python API — arcgis.mapping and Web Map Automation

Covers web map and web scene automation with the `arcgis.mapping` module (reorganized into `arcgis.map` in arcgis 2.3+). The `WebMap` class wraps a web map item's JSON: `wm = WebMap(item)`, `wm.layers`, `wm.add_layer(feature_layer, options={"title": ..., "opacity": ...})`, `wm.remove_layer()`, `wm.basemap = "topo-vector"`, then `wm.save(item_properties)` or `wm.update()` to persist — the standard way to batch-retarget layers when a service URL changes. `WebScene` does the same for 3D. Covers renderer and popup manipulation through layer definition dicts (`layerDefinition.drawingInfo.renderer`, `popupInfo`), `generate_renderer()` helpers, and symbology JSON following the web map specification. Printing/export via `arcgis.mapping.export_map()` which calls the portal's PrintingTools GPServer for PNG/PDF output of web map JSON. Offline workflows through `OfflineMapAreaManager` (`wm.offline_areas.create()`) for Field Maps preplanned areas. Also includes vector tile and map service wrappers (`VectorTileLayer`, `MapImageLayer`), and the notebook map widget (`gis.map("Dublin, Ireland")`) with `.add_layer()` and `.export_to_html()`. Notes that editing web map JSON directly requires conforming to the webmap spec version the portal expects.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.mapping / arcgis.map module reference and the web map specification).
