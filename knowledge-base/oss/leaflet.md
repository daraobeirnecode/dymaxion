---
title: Leaflet
category: oss
topic_tags: [leaflet, web-mapping, plugins, geojson, lightweight]
status: stub
---

# Leaflet

Leaflet is the lightweight (~42 KB) DOM/Canvas mapping library: `L.map('div').setView([38.58, -121.49], 12)` plus `L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: ...})` is a working map in five lines, which is why it remains the default for simple embeds, dashboards, and CMS widgets. Core API: `L.marker`, `L.circleMarker`, `L.polygon`, `L.geoJSON(data, {style, onEachFeature, pointToLayer})` with `.bindPopup()`/`.bindTooltip()`, layer groups, and `L.control.layers(baseMaps, overlays)` for the classic layer switcher. The plugin ecosystem is its superpower: Leaflet.markercluster (point clustering), Leaflet.draw / Leaflet-Geoman (editing), Leaflet.heat (heatmaps), leaflet-omnivore (CSV/KML/WKT loading), Esri Leaflet (Feature/Map/Vector services against ArcGIS), and protomaps-leaflet or maplibre-gl-leaflet for vector tiles. Limits that signal it is time to move up: raster-tile-first rendering (vector tiles only via plugins, no data-driven GPU styling), SVG/DOM markers degrade beyond a few thousand features (use `preferCanvas: true` or clustering before giving up), no rotation/pitch/3D, and Web Mercator only without the Proj4Leaflet plugin. Decision rule: Leaflet when the map is a supporting widget with modest data and standard XYZ/WMS layers; MapLibre when you need vector-tile basemaps, expressions, or smooth camera work; OpenLayers when OGC depth or projections dominate. Version 1.9.x is the long-stable line with Leaflet 2.0 (ESM, modernized internals) in alpha as of 2025. It pairs well with Turf.js for client-side analysis since both speak plain GeoJSON.

TODO: expand from authoritative source (leafletjs.com/reference.html).
