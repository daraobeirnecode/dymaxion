---
title: ArcGIS Enterprise vs ArcGIS Online vs Open Source Stack
category: architecture
topic_tags: [arcgis-enterprise, arcgis-online, open-source, platform-selection, licensing, cost]
status: stub
---

# ArcGIS Enterprise vs ArcGIS Online vs Open Source Stack

Three platform families cover most GIS service needs. ArcGIS Online (SaaS): zero infrastructure, credit-based pricing (storage, premium analysis, geocoding all consume credits), hosted feature/tile layers, instant sharing — but no control over compute, data residency limits, and costs that scale unpredictably with heavy analytics or dense tile caches. ArcGIS Enterprise (self-hosted Portal + Server + Data Store): full control, enterprise geodatabase integration, branch versioning, Utility Network, ArcGIS Pro publishing workflows, image services — at the price of named-user + core licensing, Windows/Linux VM administration, and upgrade cycles; it is the only option when data must stay on-premises or when advanced Esri capabilities (versioned editing services, GeoEvent, raster analytics) are required. The OSS stack (PostGIS + GeoServer or pg_tileserv/Martin + QGIS + MapLibre + GDAL, optionally Koop to speak GeoJSON/Feature-Service dialect) has zero license cost, total architectural freedom, and best-in-class formats (COG, PMTiles, GeoParquet) — the costs are integration engineering, no vendor support contract, and no drop-in equivalents for Field Maps-style offline sync, Survey123, or the Living Atlas. Interop softens the boundary: GeoServer speaks WMS/WFS/WMTS that ArcGIS clients consume, Koop republishes anything as Feature-Service-compatible endpoints, and OGC API Features is increasingly common ground. Cost shape differs more than total cost: AGOL is opex that grows with usage, Enterprise is license + infrastructure step functions, OSS is engineering time up front and at upgrades. Common hybrid: authoritative data and heavy processing on OSS/PostGIS, publication of curated layers to AGOL for the org's field and viewer users. Decide per workload, not per organization — and record the decision with its tradeoffs, since "recommend, with tradeoffs" is the honest frame for platform advice.

TODO: expand from authoritative source (Esri ArcGIS Enterprise and Online documentation/pricing; OSGeo project documentation; Koop docs at koopjs.github.io).
