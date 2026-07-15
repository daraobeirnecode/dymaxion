---
title: MBTiles vs PMTiles
category: oss
topic_tags: [mbtiles, pmtiles, tiles, tippecanoe, serverless, tile-formats]
status: stub
---

# MBTiles vs PMTiles

MBTiles is a SQLite database with a `tiles` table keyed by `zoom_level, tile_column, tile_row` (TMS y-flipped) plus a `metadata` table — a mature container read by TileServer GL, Martin, QGIS, and GDAL, but it requires a server process because HTTP clients cannot range-read SQLite efficiently. PMTiles (Protomaps) is a single-file archive purpose-built for HTTP range requests: a clustered, Hilbert-ordered directory structure lets a browser fetch any tile from a static file on S3/Cloudflare R2/GitHub Pages with 1–2 range GETs — "serverless" tile hosting with a CDN doing the work. Create MBTiles from GeoJSON/FlatGeobuf with tippecanoe (`tippecanoe -o out.mbtiles -zg --drop-densest-as-needed input.geojson`, or `-o out.pmtiles` directly since tippecanoe 2.17); convert existing archives with `pmtiles convert in.mbtiles out.pmtiles`, and inspect with `pmtiles show`/`pmtiles verify`. MapLibre consumes PMTiles via the `pmtiles` JS plugin registering a `pmtiles://` protocol (`addProtocol`), while MBTiles always needs a server (TileServer GL, Martin) to expose z/x/y URLs. Deduplication: PMTiles stores identical tiles (e.g., empty ocean) once; both formats hold vector (gzip MVT) or raster tiles. Operational tradeoffs: PMTiles wins on hosting cost, simplicity, and offline distribution (one file, works from a CDN or `file://` in native apps); MBTiles wins on ecosystem maturity and mutable workflows (SQLite is easy to update incrementally, PMTiles archives are effectively immutable — regenerate to update). Both are z/x/y pyramids, distinct from on-the-fly MVT out of PostGIS: bake archives for stable basemap-scale data, generate live tiles for hot operational tables. Basemap-scale planet builds: Planetiler emits either format from OSM in hours on one machine.

TODO: expand from authoritative source (github.com/protomaps/PMTiles spec and github.com/mapbox/mbtiles-spec).
