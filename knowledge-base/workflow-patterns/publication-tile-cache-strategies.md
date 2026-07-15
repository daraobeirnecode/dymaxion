---
title: "Publication: Tile Cache Generation Strategies"
category: workflow-patterns
topic_tags: [tile-cache, seeding, on-demand, geowebcache, vector-tiles, zoom-levels]
status: stub
---

# Publication: Tile Cache Generation Strategies

The core trade-off is pre-generation (seed everything up front: predictable latency, large storage and long build times) versus on-demand rendering with cache-on-first-hit (fast to deploy, cold-tile latency, risk of thundering herds on popular extents). Tile counts quadruple per zoom level — a county at z0–z12 is trivial, z0–z18 can be tens of millions of tiles — so the standard hybrid is: seed low zooms fully (z0–z12 or wherever count stays under ~1M), render high zooms on demand, and optionally pre-seed high zooms only inside populated-area polygons. Tools: GeoWebCache seed jobs (REST `seed` endpoint, per-gridset, with metatiling 4x4 to cut render overhead), MapProxy `mapproxy-seed` with coverage geometries, Esri `Manage Map Server Cache Tiles` with feature-class AOI, and tippecanoe/planetiler for build-once vector tile artifacts. Vector tiles shift the balance: MVT pyramids are much smaller than raster (styling happens client-side), so full pre-generation to z14 with overzooming beyond is standard practice (tippecanoe `-zg`, `--drop-densest-as-needed`). Static-artifact caches (MBTiles, PMTiles on object storage) eliminate the tile server entirely and suit data that changes on a schedule; live GeoWebCache/dynamic caches suit continuous edits paired with dirty-tile truncation. Set cache expiry headers deliberately (`Cache-Control: max-age` aligned to refresh cadence) and version the tile URL path (`/tiles/v3/{z}/{x}/{y}.pbf`) so CDN invalidation is a path flip rather than a purge. Measure before seeding: a week of on-demand logs shows which extents users actually hit, and seeding only those typically covers >95% of traffic at a fraction of the cost.

TODO: expand from authoritative source (GeoWebCache seeding docs; MapProxy seeding docs; Esri map/vector tile cache workflows on pro.arcgis.com).
