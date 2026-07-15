---
title: MapLibre Style Spec, Sources, and Layers
category: oss
topic_tags: [maplibre, style-spec, sources, layers, vector-tiles, geojson]
status: stub
---

# MapLibre Style Spec, Sources, and Layers

A MapLibre style is a single JSON document (`version: 8`) declaring `sources`, `layers`, `glyphs`, `sprite`, and optional `terrain`/`fog`/`sky` — the map is entirely described by this document, and `map.setStyle()` swaps it wholesale. Source types: `vector` (MVT via `tiles: [url]` or a TileJSON `url`), `raster` (XYZ imagery, set `tileSize: 256`), `raster-dem` (terrain encodings: `terrarium` or `mapbox`), `geojson` (inline data or URL, with `cluster: true`, `clusterRadius`, and `promoteId` options), `image`, and `video`. Layers reference a source (vector layers also need `source-layer` naming the layer inside the tile) and have a `type`: `fill`, `line`, `symbol` (icons + text), `circle`, `heatmap`, `fill-extrusion` (3D buildings), `raster`, `hillshade`, and `background`. Each layer splits properties into `layout` (evaluated at layout time: `line-cap`, `text-field`, `icon-image`, `visibility`) and `paint` (GPU-evaluated: `fill-color`, `line-width`, `fill-opacity`), plus `filter` expressions, `minzoom`/`maxzoom`, and draw order determined by array position (insert precisely with `map.addLayer(layer, beforeId)`). Runtime API mirrors the spec: `map.addSource(id, def)`, `map.addLayer(def)`, `map.setPaintProperty(id, 'fill-color', ...)`, `map.setFilter(id, expr)`, and `map.getSource(id).setData(geojson)` for live GeoJSON updates. `glyphs` is a URL template for font PBF ranges and `sprite` points to the icon atlas — Martin or a static host can serve both. MapLibre GL JS v3+ diverged from Mapbox GL v1 (fork point) with additions like `globe` projection support in v5, but the style spec remains largely compatible with Mapbox v8 styles. Free style starting points: OpenFreeMap, Protomaps basemaps, and MapTiler's open styles, all editable in Maputnik (open-source visual style editor).

TODO: expand from authoritative source (maplibre.org/maplibre-style-spec).
