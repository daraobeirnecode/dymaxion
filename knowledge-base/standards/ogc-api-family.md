---
title: "OGC API Family: Features, Tiles, Coverages, Records, EDR"
category: standards
topic_tags: [ogc-api, features, tiles, edr, openapi, rest]
status: stub
---

# OGC API Family: Features, Tiles, Coverages, Records, EDR

The OGC API family rebuilds the classic services as resource-oriented JSON/HTTP APIs described by OpenAPI 3, with a shared Common core (landing page, `/conformance`, `/collections`). OGC API — Features (Part 1 "Core" is ISO 19168-1, the successor to WFS) serves features at `/collections/{id}/items` with `bbox`, `datetime`, and `limit` parameters, GeoJSON as the default encoding, and paging via `next` links; Part 2 adds CRS negotiation (`crs` parameter beyond the default CRS84) and Part 3 adds CQL2 filtering. OGC API — Tiles standardizes tile access (`/tiles/{tileMatrixSetId}/{z}/{y}/{x}`) for vector and map tiles over the TileMatrixSet 2.0 standard — the standards-track home for MVT serving. OGC API — Coverages succeeds WCS for raster/datacube subsetting, and OGC API — Records succeeds CSW with searchable JSON catalog records that align closely with STAC (SpatioTemporal Asset Catalog), which itself became the de facto imagery catalog spec. OGC API — EDR (Environmental Data Retrieval) offers query-by-geometry conveniences (`/position`, `/radius`, `/cube`, `/trajectory`) over met-ocean and time-series data — the pattern for "give me the values at this point" APIs. Implementations to know: pygeoapi (reference implementation across many parts), GeoServer (Features/Tiles via community modules), ldproxy, QGIS (native OGC API Features client), GDAL's OAPIF driver, and Esri's support for publishing OGC API Features from ArcGIS Server/Online. For new public data APIs, OGC API Features + GeoJSON is now the least-friction interoperable choice, with STAC/Records for catalogs. Design note: conformance classes matter — clients must check `/conformance` because servers implement parts à la carte.

TODO: expand from authoritative source (ogcapi.ogc.org specifications; pygeoapi documentation; STAC spec at stacspec.org).
