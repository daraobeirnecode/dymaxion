---
title: GeoServer REST API
category: oss
topic_tags: [geoserver, rest-api, publishing, workspaces, automation]
status: stub
---

# GeoServer REST API

GeoServer's REST API (rooted at `/geoserver/rest`) makes layer publishing fully scriptable: everything the admin UI does — workspaces, stores, layers, styles, layer groups, GWC caches — is a JSON/XML resource under paths like `/rest/workspaces`, `/rest/workspaces/{ws}/datastores`, `/rest/layers`, and `/rest/styles`. Typical PostGIS publish flow: `POST /rest/workspaces` with `{"workspace":{"name":"dymaxion"}}`, then `POST /rest/workspaces/dymaxion/datastores` with connection params (host, port, database, user, passwd, dbtype=postgis), then `POST .../datastores/{ds}/featuretypes` naming the table — GeoServer introspects the schema and bounds. Upload data directly with `PUT .../datastores/{ds}/file.shp` (zipped shapefile) or `PUT .../coveragestores/{cs}/file.geotiff` for rasters. Styles: `POST /rest/styles` with SLD body (`Content-Type: application/vnd.ogc.sld+xml`), then associate via `PUT /rest/layers/{layer}` setting `defaultStyle`. Auth is HTTP Basic against GeoServer users (default admin/geoserver — change it); all writes need `Content-Type` headers and return 201 on create. Cache management lives under `/gwc/rest`, e.g. seeding with `POST /gwc/rest/seed/{layer}.json`. Useful query endpoints: `GET /rest/about/version`, `GET /rest/layers.json`, and `GET /rest/resource` for the data directory. Client libraries exist (Python `geoserver-restconfig`, `geoserver-rest`), but plain `curl`/`fetch` is often clearer in ETL scripts and CI.

TODO: expand from authoritative source (docs.geoserver.org — REST API reference).
