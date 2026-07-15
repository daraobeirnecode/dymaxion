---
title: MapLibre Interactivity, Popups, and Draw Tools
category: oss
topic_tags: [maplibre, popups, events, hover, queryrenderedfeatures, draw]
status: stub
---

# MapLibre Interactivity, Popups, and Draw Tools

Interactivity centers on layer-scoped events: `map.on('click', 'parcels-fill', (e) => { const f = e.features[0]; ... })` delivers the clicked features with their vector-tile properties, and `map.on('mouseenter'/'mouseleave', layerId, ...)` toggles `map.getCanvas().style.cursor = 'pointer'`. Arbitrary point-in-time queries use `map.queryRenderedFeatures(pointOrBbox, {layers: [...]})` (visible, tiled features only — clipped at tile borders) and `map.querySourceFeatures(sourceId)` for source-level access. Popups: `new maplibregl.Popup({offset: 12}).setLngLat(e.lngLat).setHTML(...).addTo(map)` — sanitize any property values before `setHTML`, or use `setText`/`setDOMContent`. Hover highlighting should use feature-state, not filters: on `mousemove` call `map.setFeatureState({source, sourceLayer, id}, {hover: true})` and style with `["case", ["boolean", ["feature-state","hover"], false], ...]`, clearing the previous id on each move — this avoids relayout and stays at 60fps. Built-in controls: `NavigationControl`, `ScaleControl`, `FullscreenControl`, `GeolocateControl` (with `trackUserLocation`), `AttributionControl`, added via `map.addControl(ctrl, 'top-right')`. Drawing and editing geometries comes from ecosystem libraries since mapbox-gl-draw v1.4+ retains MapLibre compatibility: `new MapboxDraw({controls: {polygon: true, trash: true}})` emits `draw.create`/`draw.update`/`draw.delete` events with GeoJSON payloads; Terra Draw is the newer MapLibre-native alternative supporting rectangles, circles, and freehand. Camera choreography uses `map.flyTo({center, zoom, pitch, bearing})`, `map.fitBounds(bbox, {padding: 40})`, and `map.easeTo`; listen to `moveend` to sync UI or fetch data for the new viewport (`map.getBounds()`).

TODO: expand from authoritative source (maplibre.org/maplibre-gl-js/docs — API Reference and Examples).
