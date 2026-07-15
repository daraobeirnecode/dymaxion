---
title: Deck.gl Layers and WebGL Rendering
category: oss
topic_tags: [deckgl, webgl, visualization, big-data, maplibre-integration, layers]
status: stub
---

# Deck.gl Layers and WebGL Rendering

Deck.gl (OpenJS/vis.gl, originally Uber) renders very large datasets — millions of points, paths, and polygons — through GPU-instanced WebGL2/WebGPU layers, taking over where MapLibre/Leaflet rendering saturates. Core layer catalog: `ScatterplotLayer` (points), `ArcLayer` and `LineLayer` (OD flows), `PathLayer`, `PolygonLayer`/`SolidPolygonLayer`, `GeoJsonLayer` (auto-splits by geometry type), `IconLayer`, `TextLayer`, `HeatmapLayer`, aggregation layers `HexagonLayer`/`GridLayer`/`ScreenGridLayer` (with `getElevationWeight` for 3D histograms), `TripsLayer` (animated trajectories), `TileLayer`/`MVTLayer` for tiled vectors, `Tile3DLayer` for 3D Tiles, and `TerrainLayer`. Layers are declarative: `new ScatterplotLayer({id, data, getPosition: d => d.coords, getRadius: d => d.mag * 100, getFillColor: [255,140,0], pickable: true})` — changing props triggers efficient diffing, and `data` accepts arrays, promises, or binary typed-array attribute tables for maximum throughput. Integration with MapLibre has two modes: overlaid (independent canvas, `new MapboxOverlay({interleaved: false, layers})` added via `map.addControl`) and interleaved (deck layers rendered inside the basemap's WebGL context, so extrusions/labels correctly occlude deck geometry — set `interleaved: true` and give layers `beforeId`). React usage goes through `@deck.gl/react`'s `<DeckGL layers={...} initialViewState={...} controller>` wrapping a `<Map>` from react-map-gl/maplibre. Picking (`pickable: true`, `onHover`/`onClick` with picked `object`) runs on the GPU via a color-encoding pass, so interactivity stays cheap at scale. Reach for deck.gl when feature counts exceed ~50–100k styled features, when you need aggregation visuals (hexbins, heatmaps) or animation, and keep plain MapLibre layers for basemap-scale cartography.

TODO: expand from authoritative source (deck.gl/docs — layer catalog and MapLibre integration guides).
