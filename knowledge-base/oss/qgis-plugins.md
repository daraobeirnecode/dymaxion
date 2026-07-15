---
title: QGIS Plugins Ecosystem
category: oss
topic_tags: [qgis, plugins, quickmapservices, qgis2web, extensions]
status: stub
---

# QGIS Plugins Ecosystem

QGIS plugins are Python packages installed from the official repository (plugins.qgis.org, ~2000 published) via Plugins > Manage and Install, or unzipped into the profile's `python/plugins` directory. Staples worth knowing by name: QuickMapServices (adds OSM/ESRI/Google basemaps as XYZ layers), qgis2web (exports a project to Leaflet/OpenLayers/MapLibre web maps), Semi-Automatic Classification Plugin (SCP, supervised classification of Landsat/Sentinel imagery with band-set preprocessing), MMQGIS (vector CSV/geocoding/animation utilities), DB Manager (bundled — SQL window against PostGIS/SpatiaLite), QuickOSM (Overpass API queries straight to layers), Lat Lon Tools, Profile Tool, and TimeManager successors for temporal animation. Data-provider plugins can add whole backends (e.g., the Planet, STAC API, and GEE plugins). A minimal plugin is `metadata.txt` plus `__init__.py` exposing `classFactory(iface)`; scaffold with the Plugin Builder plugin and reload during development with Plugin Reloader; `pb_tool` and `pyqt5ac` help with build/deploy. Plugins can register Processing providers, expression functions, map tools, and dock widgets — the same extension points Dymaxion could target if it ever authors a QGIS-side helper. Vet plugins by maintenance date and repo activity: abandoned plugins break across QGIS LTR upgrades (3.x API is stable, but Qt6 migration in QGIS 4 will churn the ecosystem). Experimental-flagged plugins require enabling "Show also experimental plugins" in settings.

TODO: expand from authoritative source (plugins.qgis.org and docs.qgis.org — Building plugins).
