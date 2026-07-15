---
title: arcgis Python API — The GIS Object and Portal Connections
category: esri
topic_tags: [arcgis-python-api, gis-object, portal, content-search, users, groups]
status: stub
---

# arcgis Python API — The GIS Object and Portal Connections

Covers `arcgis.gis.GIS`, the entry point of the arcgis Python API (which runs on Mac and Linux, unlike arcpy, because it speaks ArcGIS REST directly). Connection forms: `GIS()` for anonymous arcgis.com, `GIS("https://org.maps.arcgis.com", "user", "password")`, `GIS(url, client_id=...)` for OAuth interactive login, `GIS(api_key=...)`, `GIS("pro")` to borrow the ArcGIS Pro session, and `GIS(url, username, password, verify_cert=False)` for self-signed Enterprise portals; credentials can also come from a stored profile (`GIS(profile="work")`). Content discovery via `gis.content.search(query="owner:me type:Feature Layer", max_items=100)` and `gis.content.get(item_id)` returning `Item` objects with `.layers`, `.download()`, `.share()`, `.delete()`. Administration via `gis.users` (`.search()`, `.create()`, `UserManager`), `gis.groups`, and `gis.admin` for org settings, licenses, and credits (`gis.admin.credits`). Publishing enters through `gis.content.add(item_properties, data=path)` followed by `item.publish()`. Also touches `gis.map()` for notebook map widgets and the `arcgis.env` module for analysis defaults. Notes version coupling between the `arcgis` package and portal versions, and that search uses the portal's Lucene-style query syntax.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.gis module reference).
