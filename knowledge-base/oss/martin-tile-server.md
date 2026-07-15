---
title: Martin Tile Server
category: oss
topic_tags: [martin, vector-tiles, mvt, postgis, rust, pmtiles]
status: stub
---

# Martin Tile Server

Martin (maintained under MapLibre, written in Rust) is a high-performance tile server that publishes PostGIS tables/functions as MVT and also serves MBTiles and PMTiles archives — benchmarks consistently place it well ahead of pg_tileserv under concurrent load thanks to async Rust and connection pooling. Run it with `martin postgresql://user:pass@host/db` for auto-discovery, or a `config.yaml` declaring `postgres:` sources (tables with geometry column, srid, extent, buffer, `clip_geom`) plus `mbtiles:`/`pmtiles:` file sources. Endpoints: `/{source}/{z}/{x}/{y}` for tiles, `/catalog` for the source list, and TileJSON at `/{source}` — composite sources combine multiple tables into one multi-layer tile via `/{source1},{source2}/{z}/{x}/{y}`. Like pg_tileserv it supports function sources (`(z, x, y, query json)` returning bytea) for parameterized/aggregated tiles. The companion CLI `martin-cp` bulk-generates tiles from any source into MBTiles (pre-seeding), and `mbtiles` (also bundled) copies/diffs/validates MBTiles files and converts between flat and normalized schemas. Extras that pg_tileserv lacks: built-in sprite generation from SVG directories (`/sprite`), font glyph serving (`/font/{fontstack}/{start}-{end}`), and native PMTiles-over-HTTP proxying — enough to serve a complete MapLibre style stack from one binary. Docker image is `ghcr.io/maplibre/martin`; typical deployment is Martin + nginx/CDN cache. Choose Martin when tile throughput matters, when you want one server for live PostGIS plus static archives, or when you need sprites/fonts without a separate static host.

TODO: expand from authoritative source (maplibre.org/martin documentation).
