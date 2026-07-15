---
title: QGIS Server
category: oss
topic_tags: [qgis-server, wms, wfs, wmts, ogc-services, publishing]
status: stub
---

# QGIS Server

QGIS Server publishes a QGIS Desktop project (.qgs/.qgz) as OGC services — WMS 1.3.0, WFS 2.0 (and OGC API Features), WMTS, and WCS — with rendering identical to the desktop because it uses the same libqgis engine, so desktop symbology, labels, and print layouts carry straight to the web. It runs as a FastCGI/CGI binary (`qgis_mapserv.fcgi`) behind nginx or Apache, or via Docker images like `qgis/qgis-server`; each service request carries `MAP=/path/to/project.qgz` plus standard params (`SERVICE=WMS&REQUEST=GetMap&LAYERS=...&CRS=EPSG:3857&BBOX=...`). Project settings under "QGIS Server" configure service capabilities, WFS-published layers, advertised extents, and exclude-from-legend flags. GetPrint requests render desktop print layouts to PDF/PNG server-side — a differentiator over GeoServer/MapServer. Performance depends on project hygiene: use PostGIS sources over shapefiles, set scale-dependent rendering, enable the `QGIS_SERVER_CACHE_DIR`/trust-project options, and front it with MapProxy or a WMTS cache for tiles. Python server plugins can add filters, access control (per-layer/per-attribute), and custom services. Common deployment pairs it with py-qgis-server or qgis-server-light for multiprocess scaling. Choose QGIS Server when cartography is authored in QGIS and must render pixel-identical on the web; choose GeoServer when REST-driven programmatic publishing is the priority.

TODO: expand from authoritative source (docs.qgis.org — QGIS Server Guide).
