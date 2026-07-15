---
title: "ETL: Change Data Capture from Feature Services via editDate"
category: workflow-patterns
topic_tags: [cdc, feature-service, arcgis-rest, editdate, incremental, sync]
status: stub
---

# ETL: Change Data Capture from Feature Services via editDate

ArcGIS Feature Services with editor tracking enabled expose `last_edited_date` (and `created_date`, `last_edited_user`) fields, which support incremental pulls without full re-downloads: `query?where=last_edited_date > TIMESTAMP '2026-07-01 00:00:00'&outFields=*&f=json`. Confirm tracking via the layer's JSON (`editFieldsInfo.editDateField`) and note that timestamps are epoch milliseconds in UTC — off-by-timezone watermarks are the top CDC bug. Persist a per-layer watermark (max `last_edited_date` seen, minus a small overlap window of 1–5 minutes to absorb clock skew and in-flight transactions) in a `dymaxion.datasets`-linked state table, and make the apply step idempotent so overlap re-reads are harmless. Deletes do not appear in queries — options are the `extract Changes` capability (`extractChanges` with `returnDeletes=true` on sync-enabled services, using `serverGens` layer generation numbers), periodic full-key reconciliation against `returnIdsOnly=true`, or soft-delete flags maintained by the publisher. Page large pulls with `resultOffset`/`resultRecordCount` (respecting `maxRecordCount`, typically 1000–2000) or `orderByFields=OBJECTID` keyset pagination; request `f=geojson` only if the service supports it, otherwise parse Esri JSON. The hosted-service `editingInfo.lastEditDate` on the layer resource is a cheap pre-check: if unchanged since the last run, skip the query entirely. Land changes into bronze, then upsert to silver keyed on GlobalID with the hash-guard pattern.

TODO: expand from authoritative source (ArcGIS REST API docs: Query (Feature Service/Layer), Extract Changes, sync overview at developers.arcgis.com).
