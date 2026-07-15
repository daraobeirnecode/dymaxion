---
title: ArcGIS REST API Rate Limits and Pagination
category: esri
topic_tags: [rest-api, pagination, rate-limits, maxrecordcount, exceededtransferlimit]
status: stub
---

# ArcGIS REST API Rate Limits and Pagination

Covers how to pull large result sets safely and what throttling to expect. Every feature layer advertises `maxRecordCount` (typically 1000–2000; up to 32000 for some hosted layers) — a query returning exactly that many rows with `"exceededTransferLimit": true` means more data remains. Standard paging loops on `resultOffset`/`resultRecordCount` when the layer's `advancedQueryCapabilities.supportsPagination` is true; otherwise fall back to `returnIdsOnly=true` then chunked `objectIds` requests, or `where OBJECTID > lastSeen` keyset pagination with `orderByFields=OBJECTID`. The `f=pbf` format and `quantizationParameters` reduce transfer size for geometry-heavy pulls; `resultType=tile` requests use the (often larger) tileMaxRecordCount. On rate limiting: ArcGIS Online applies per-service throttling and returns HTTP 429 or error code 503/`"Too many requests"` under load — respect `Retry-After`, add exponential backoff, and keep concurrency modest (Esri guidance is roughly single-digit parallel requests per service). Credits meter certain AGOL operations (geocoding, geoenrichment, spatial analysis) rather than raw query volume, while self-hosted Enterprise limits are governed by service instance pooling (min/max instances per SOC process). Includes the pattern of using `returnCountOnly=true` first to plan page counts and estimate runtime.

TODO: expand from authoritative source (developers.arcgis.com REST API documentation and ArcGIS Online service limits pages).
