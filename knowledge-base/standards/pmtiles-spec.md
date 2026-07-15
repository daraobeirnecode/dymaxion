---
title: PMTiles Specification
category: standards
topic_tags: [pmtiles, tiles, protomaps, range-requests, serverless, mbtiles]
status: stub
---

# PMTiles Specification

PMTiles (Protomaps, spec v3) is a single-file archive for an entire tile pyramid, designed so any tile is retrievable with at most a few HTTP range requests from static storage — the serverless successor to MBTiles, which requires SQLite and therefore a server. The v3 layout is: a 127-byte fixed header, a root directory of tile entries, optional leaf directories (for large archives), JSON metadata, and the tile data section; tile IDs are ordered on a Hilbert curve, which clusters spatially adjacent tiles for cache-friendly reads, and identical tiles are deduplicated via run-length entries (huge wins for ocean/empty tiles). Directories are internally compressed, and tile contents carry their own compression/type flags (MVT, PNG, JPEG, WebP, AVIF all supported). Tooling: the `pmtiles` CLI converts MBTiles↔PMTiles (`pmtiles convert planet.mbtiles planet.pmtiles`), tippecanoe ≥ 2.17 emits PMTiles directly (`-o out.pmtiles`), and planetiler builds planet-scale basemaps into it. Serving is storage plus CORS-and-range-request support: S3, Cloudflare R2, or any static host works, with the JS client (`pmtiles` npm package adding a `pmtiles://` protocol to MapLibre GL) reading directly in the browser, or a tiny edge function (Cloudflare Worker / Lambda) translating `/z/x/y` URLs for legacy clients and CDN caching. The Protomaps basemap project distributes daily OpenStreetMap planet builds as PMTiles (~100 GB), making "self-host a global basemap" a file-copy operation. Compared to MBTiles it trades SQL queryability for zero-infrastructure serving; compared to tile directories it trades per-tile file access for million-fold fewer objects. For county-scale Dymaxion deliverables, one PMTiles artifact on object storage behind a CDN is often the entire tile architecture.

TODO: expand from authoritative source (PMTiles v3 spec at github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md; protomaps.com docs).
