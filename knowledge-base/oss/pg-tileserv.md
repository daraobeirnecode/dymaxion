---
title: pg_tileserv
category: oss
topic_tags: [pg-tileserv, vector-tiles, mvt, postgis, tile-server]
status: stub
---

# pg_tileserv

pg_tileserv (Crunchy Data, Go) auto-publishes every spatially indexed PostGIS table or view the connection role can see as Mapbox Vector Tiles — zero config beyond `DATABASE_URL=postgres://user:pass@host/db ./pg_tileserv`. Tiles are served at `/{schema}.{table}/{z}/{x}/{y}.pbf`, a web UI at `:7800/` lists layers with preview maps, and `/index.json` provides machine-readable TileJSON-ish metadata per layer. Under the hood every request becomes `ST_AsMVT`/`ST_AsMVTGeom` SQL, so freshness is live — edits in PostGIS appear on the next tile request with no re-seeding, which suits frequently changing operational data. Function layers are the power feature: any SQL function with signature `(z integer, x integer, y integer, ...)` returning `bytea` MVT is exposed at `/{schema}.{function}/{z}/{x}/{y}.pbf`, enabling parameterized tiles (filtering, aggregation, hexbinning) driven by query-string arguments. Config file (`pg_tileserv.toml`) controls `DbConnection`, `HttpPort`, `DefaultResolution` (default 4096), `MaxFeaturesPerTile`, CORS, and cache-control headers; attribute selection and layer visibility are governed by database GRANTs — publish-by-permission is the security model. It does no caching itself: put a CDN, nginx proxy cache, or varnish in front for production traffic. Compared to Martin it is simpler and slower at high concurrency; compared to baking PMTiles it trades throughput for real-time data. Pairs naturally with MapLibre: add the endpoint as a `vector` source and style with a `source-layer` matching the table name.

TODO: expand from authoritative source (github.com/CrunchyData/pg_tileserv documentation).
