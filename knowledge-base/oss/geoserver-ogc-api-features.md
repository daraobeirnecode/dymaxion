---
title: OGC API Features (GeoServer and Beyond)
category: oss
topic_tags: [ogc-api-features, geoserver, rest, geojson, wfs3, pygeoapi]
status: stub
---

# OGC API Features (GeoServer and Beyond)

OGC API — Features (formerly "WFS3") replaces XML/KVP WFS with a plain RESTful JSON API: `GET /collections` lists layers, `GET /collections/{id}/items?bbox=-122.6,38.2,-121.0,39.0&datetime=...&limit=100` returns a GeoJSON FeatureCollection with `next` links for paging, and `GET /collections/{id}/items/{featureId}` fetches one feature. The landing page (`/`) and `/conformance` advertise capabilities, and `/api` serves an OpenAPI 3.0 document — meaning generic REST tooling, not GIS-specific clients, can consume it. Part 1 (Core) covers bbox/datetime/limit queries; Part 2 adds CRS negotiation beyond WGS84 (`crs=` parameter); Part 3 (Filtering) brings CQL2 filters (`filter=zone='R1' AND area>1000`); Part 4 (Create/Replace/Update/Delete) covers transactions. In GeoServer it ships via the `ogcapi-features` community/extension module, mounting at `/geoserver/ogc/features/v1` over the same published layers as classic WFS. Alternative servers with first-class support: pygeoapi (Python, config-driven), ldproxy, FastAPI-based TiPg (PostGIS-native), and pg_featureserv (Crunchy Data's lightweight Go server that auto-publishes PostGIS tables). GDAL/OGR reads it via the `OAPIF` driver, so `ogr2ogr` can pull from any conformant endpoint, and QGIS adds these as "WFS / OGC API Features" connections. Prefer it over classic WFS for new integrations: browser-friendly JSON, sane paging, and OpenAPI discoverability; fall back to WFS 2.0 only for legacy clients or GML-mandated workflows.

TODO: expand from authoritative source (ogcapi.ogc.org/features and docs.geoserver.org — OGC API modules).
