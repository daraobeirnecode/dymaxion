---
title: arcgis Python API — Content Management with Item.update and gis.content
category: esri
topic_tags: [arcgis-python-api, item-update, content-management, publish, clone-items, metadata]
status: stub
---

# arcgis Python API — Content Management with Item.update and gis.content

Covers programmatic item lifecycle management in a portal. `item.update(item_properties={"title": ..., "snippet": ..., "description": ..., "tags": "a,b,c"}, data=r"/path/new_data.zip", thumbnail=...)` edits metadata and/or replaces the underlying file of an item in place, preserving the item ID — the backbone of scheduled data refreshes (update the source CSV/FGDB item, then `item.publish(overwrite=True)` or `FeatureLayerCollection.fromitem(item).manager.overwrite(path)`). Item creation via `gis.content.add()` (Pro 2.x-era) and the newer `gis.content.folders` API (`folder.add(item_properties, file=...)` returning a job in arcgis 2.3+). Sharing and governance: `item.share(everyone=False, org=True, groups=[...])` (newer `item.sharing` API), `item.move(folder)`, `item.protect(enable=True)` against deletion, `item.reassign_to(target_owner)`, and `item.delete()` (destructive). Covers `item.dependent_upon()`/`item.dependent_to()` for tracing web map dependencies, `gis.content.clone_items(items, ...)` for migrating content between portals with dependency rewiring, and `item.export(title, export_format="Shapefile"|"File Geodatabase"|"GeoJSON")` for extracts. Also `item.metadata` for full ISO metadata, `item.usage()` statistics on AGOL, and `item.content_status` for authoritative/deprecated flags. Emphasizes checking `item.access` and ownership before mutating shared production content.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.gis.Item and ContentManager reference).
