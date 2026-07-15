---
title: "Tile Strategy: CDN Placement and Cache Invalidation"
category: architecture
topic_tags: [cdn, cache-invalidation, tiles, http-caching, versioning, cloudflare]
status: stub
---

# Tile Strategy: CDN Placement and Cache Invalidation

A CDN in front of any tile endpoint is nearly free performance: tiles are immutable-ish, small, and requested in bursts along user pan paths, so edge hit rates of 90%+ are normal once headers are right. The header contract: `Cache-Control: public, max-age=<refresh-cadence>, stale-while-revalidate=<grace>` on tiles, `ETag` support for conditional revalidation, and honest `Content-Type` (`application/vnd.mapbox-vector-tile`, `image/webp`) plus `Content-Encoding: gzip` for MVT (which is internally gzip-compressed by convention — double-compression bugs are common). Invalidation strategies, weakest to strongest: TTL expiry (simplest, staleness window equals max-age), purge-by-URL (fine for single tiles, hopeless for pyramids — a county layer is millions of URLs), purge-by-tag/prefix (Cloudflare cache tags, Fastly surrogate keys — tag tiles by layer so one API call flushes a layer), and path versioning (`/tiles/v7/...` bumped per publish — instant, atomic, and old versions age out naturally; the most robust pattern). Path versioning requires the style/config that references the tile URL to update atomically with the data — version the style JSON alongside and the swap is a single pointer change. For dirty-tile pipelines (delta materialization), pair in-origin cache truncation (GeoWebCache truncate-by-bbox) with CDN tag purges scoped to the affected layer; per-tile CDN purges only make sense for small dirty sets. PMTiles-on-object-storage inverts the problem: the artifact is one file addressed by range requests, so "invalidation" is uploading a new file and flipping the URL or purging one key. Watch cache-key pitfalls: query strings (auth tokens fragment the cache — move auth to headers or signed cookies), `Vary` headers, and CORS preflights that bypass cache. Monitor hit ratio per layer; a low ratio usually means token-fragmented keys or a TTL shorter than the real update cadence.

TODO: expand from authoritative source (MDN HTTP caching reference; Cloudflare/Fastly purge and cache-tag docs; GeoWebCache truncate REST API).
