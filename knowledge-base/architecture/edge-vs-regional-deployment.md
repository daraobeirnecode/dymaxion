---
title: "Regional Deployment: Cloudflare Edge vs Regional Cloud"
category: architecture
topic_tags: [edge, cdn, cloudflare, latency, regions, pmtiles]
status: stub
---

# Regional Deployment: Cloudflare Edge vs Regional Cloud

Map traffic splits cleanly into an edge-friendly tier (tiles, styles, sprites, glyphs, static GeoJSON — immutable, cacheable, latency-sensitive) and an origin tier (PostGIS queries, editing, geoprocessing — stateful, consistency-sensitive). Push the first tier to the edge: PMTiles on Cloudflare R2 or S3+CloudFront served via range requests (or the protomaps Cloudflare Worker) gives global sub-50ms tile latency with no origin servers, and vector tile styles/fonts are pure static assets. The origin tier should live in one region close to the data's users and editors — a Sacramento-focused client is well served from us-west, and multi-region Postgres write replication is rarely worth its consistency complexity for GIS editing workloads. Cloudflare Workers/Durable Objects can host lightweight geo-APIs (point-in-polygon lookups against embedded FlatGeobuf/PMTiles, geocode caching) but have CPU and package limits that exclude GDAL-class processing. Cache keys and headers are the real engineering: version the tile path (`/v5/{z}/{x}/{y}`), set `Cache-Control: public, max-age=86400, stale-while-revalidate`, and invalidate by path-prefix flip rather than enumerating millions of tile purges. Watch egress economics — R2's zero egress fees vs S3 egress makes a real difference for public tile layers; conversely, keeping raw imagery in the same region as the compute that processes it avoids the largest transfer bills. Regulatory residency (data must remain in-country/state) constrains the origin region but rarely the cached tiles, though signed URLs at the edge are needed when tiles themselves are sensitive. Practical pattern for Dymaxion-scale work: single-region origin (Compose stack) + Cloudflare in front for tiles and static assets + Tailscale for private admin surfaces — global performance where it matters, single-region simplicity where it doesn't.

TODO: expand from authoritative source (Cloudflare R2/Workers docs; protomaps PMTiles serving guides; AWS CloudFront caching best practices).
