---
title: "OGC Classic Standards: WMS, WFS, WMTS, WCS, WPS, CSW, SOS"
category: standards
topic_tags: [ogc, wms, wfs, wmts, wcs, interoperability]
status: stub
---

# OGC Classic Standards: WMS, WFS, WMTS, WCS, WPS, CSW, SOS

The classic OGC web services share an XML/KVP idiom: every service answers `GetCapabilities` with an XML document describing layers, CRSs, and operations. WMS (Web Map Service, 1.1.1/1.3.0) returns rendered map images via `GetMap` (plus `GetFeatureInfo` for click queries); note the infamous 1.3.0 axis-order change where EPSG:4326 BBOXes become lat,lon. WFS (Web Feature Service, 1.0/1.1/2.0) returns actual features as GML via `GetFeature`, supports Filter Encoding predicates, and WFS-T adds transactional insert/update/delete. WMTS serves pre-tiled maps through fixed TileMatrixSets (e.g. GoogleMapsCompatible) via `GetTile` — the standards-track cousin of XYZ tiling. WCS (Web Coverage Service) delivers raster coverages with subsetting — actual pixel values, not pictures, for DEMs and imagery. WPS (Web Processing Service) wraps geoprocessing as `DescribeProcess`/`Execute` operations, CSW (Catalogue Service for the Web) provides metadata search over ISO 19115/19139 records (the backbone of geoportals like pycsw/GeoNetwork), and SOS (Sensor Observation Service) serves time-series observations under the O&M model. GeoServer implements WMS/WFS/WCS/WMTS (via GeoWebCache) and WPS out of the box; QGIS Server covers WMS/WFS/WCS/WMTS; ArcGIS Server can expose OGC endpoints alongside its REST services. These are being superseded by the resource-oriented OGC API family, but government SDIs, INSPIRE obligations, and legacy clients guarantee WMS/WFS remain in production for years — new builds should offer both where interop is required.

TODO: expand from authoritative source (OGC standards pages at ogc.org/standards; GeoServer services documentation).
