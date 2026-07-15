---
title: "Publication: Feature Service Overwrite vs Append"
category: workflow-patterns
topic_tags: [publication, feature-service, overwrite, append, arcgis-online, truncate]
status: stub
---

# Publication: Feature Service Overwrite vs Append

Overwrite republishes a hosted feature layer from a new source file (via the ArcGIS API for Python `FeatureLayerCollection.manager.overwrite()` or Pro's "Overwrite Web Layer"): the item ID and URL survive, but layer IDs can renumber, schema changes propagate, editor-tracking history is lost, and views/pop-ups/symbology defined downstream can break — treat it as a schema-level operation. Append (`FeatureLayer.append()`, REST `append` endpoint, supporting upsert with `upsert=true` and `upsertMatchingField` such as GlobalID) modifies rows in place: schema is preserved, sync and editor tracking continue, and it is the right tool for recurring data refreshes. The common refresh idiom is truncate-and-append (`manager.truncate()` then `append`), which keeps the item stable but briefly serves an empty layer — acceptable for nightly windows, not for 24/7 dashboards; upsert-append avoids the gap. Overwrite requires the original source item type to match (e.g. the same FGDB/CSV/GeoJSON item that created the service), a frequent automation failure. Services that are sync-enabled, versioned, have attachments, or feed join views constrain both operations — attachments survive append but not overwrite. Decision rule: schema changed or one-off replace → overwrite (then re-verify dependent maps); data-only refresh on stable schema → append with upsert; large initial loads → `applyEdits` in batches or async append from an uploaded item. Always snapshot the service definition JSON (`/rest/admin` service definition) before either operation so a broken publish is recoverable.

TODO: expand from authoritative source (ArcGIS REST API Append and Truncate docs; ArcGIS API for Python FeatureLayerCollection.manager reference).
