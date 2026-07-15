---
title: "GeoServer Service Types: WMS, WFS, WMTS, WCS"
category: oss
topic_tags: [geoserver, wms, wfs, wmts, wcs, ogc-services]
status: stub
---

# GeoServer Service Types: WMS, WFS, WMTS, WCS

WMS returns rendered map images (`GetMap` with `LAYERS`, `BBOX`, `CRS`, `WIDTH/HEIGHT`, `FORMAT=image/png`), plus `GetFeatureInfo` for click queries and `GetLegendGraphic` — use it when the server owns cartography or data is too heavy to ship as features. WFS returns actual vector features (`GetFeature` with `typeNames`, `CQL_FILTER` or OGC Filter, `outputFormat=application/json`), supports paging via `startIndex`/`count`, and WFS-T adds transactional insert/update/delete — use it for data access, editing, and interop with QGIS/desktop clients. WMTS serves pre-rendered or cached tiles through embedded GeoWebCache on fixed gridsets (`GetTile` with `TileMatrix/TileRow/TileCol`), trading flexibility for speed; GeoServer can also emit tiles in slippy-map XYZ layout and MVT vector tiles via the vector-tiles extension. WCS serves raw raster coverages (actual pixel values, not pictures) with `GetCoverage` supporting subsetting, scaling, and format negotiation — the right service for DEM or multispectral data consumed analytically. Rules of thumb: WMS for display of complex/large layers, WFS for feature access and editing, WMTS for high-traffic basemaps and any layer with stable styling, WCS for raster analysis. Cascading lets GeoServer proxy a remote WMS/WFS as a local layer — useful for aggregating third-party services under one endpoint and one auth model. All services share workspace-scoped virtual endpoints (`/geoserver/{workspace}/wms`), which keeps capabilities documents small and permissions scoped. The modern successor for the WFS role is OGC API Features (see companion doc).

TODO: expand from authoritative source (docs.geoserver.org — Services section, and ogc.org standards pages).
