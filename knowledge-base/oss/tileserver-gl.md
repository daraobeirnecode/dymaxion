---
title: TileServer GL
category: oss
topic_tags: [tileserver-gl, mbtiles, raster-tiles, vector-tiles, maplibre]
status: stub
---

# TileServer GL

TileServer GL (MapTiler, Node.js) serves vector tiles from MBTiles/PMTiles archives and — its distinguishing feature — renders them server-side into raster tiles using MapLibre GL Native, so one archive plus a style JSON yields both `/data/{id}/{z}/{x}/{y}.pbf` vector endpoints and `/styles/{id}/{z}/{x}/{y}.png` raster endpoints for clients that cannot run WebGL (legacy Leaflet apps, print pipelines, emails). Quick start: `docker run --rm -it -v $(pwd):/data -p 8080:8080 maptiler/tileserver-gl --file world.mbtiles`; a `config.json` maps named styles (`styles/*/style.json`), data sources, fonts (glyphs), and sprites. It exposes TileJSON at `/data/{id}.json`, styled map previews in the built-in web UI, static-map endpoints (`/styles/{id}/static/{lon},{lat},{zoom}/{width}x{height}.png`) for thumbnails/reports, and WMTS capabilities for OGC clients — a lot of surface area from static files. The lighter `tileserver-gl-light` npm variant drops native raster rendering (pure JS, no GPU/GL dependencies) and serves vector tiles only. Typical inputs come from Planetiler or tilemaker (OSM → MBTiles) or `tippecanoe` (GeoJSON → MBTiles/PMTiles). Compared to Martin: TileServer GL is file-archive-centric with raster rendering and static maps; Martin is PostGIS-centric with higher throughput. Compared to plain PMTiles-on-CDN: TileServer GL adds raster fallback, WMTS, and static images at the cost of running a server. For fully static hosting of the underlying data, MBTiles can be converted to PMTiles with `pmtiles convert`.

TODO: expand from authoritative source (github.com/maptiler/tileserver-gl documentation).
