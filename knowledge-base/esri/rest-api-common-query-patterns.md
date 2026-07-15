---
title: Common ArcGIS REST Query Patterns
category: esri
topic_tags: [rest-api, query-patterns, statistics, spatial-filter, top-n]
status: stub
---

# Common ArcGIS REST Query Patterns

Cookbook of recurring feature-service query recipes Dymaxion should reach for without re-deriving them. Combined spatial + attribute filter: pass `where` alongside `geometry`/`spatialRel=esriSpatialRelIntersects` — the service ANDs them, e.g. active hydrants within a district polygon. Top-N by field: `orderByFields=POP2020 DESC` with `resultRecordCount=10` (and `resultOffset=0`) returns the ten largest features without client-side sorting. Aggregated counts and group-by: `outStatistics=[{"statisticType":"count","onStatisticField":"OBJECTID","outStatisticFieldName":"cnt"}]` with `groupByFieldsForStatistics=ZONING` replaces downloading all rows; statisticType also supports `sum`, `min`, `max`, `avg`, `stddev`, `var`. Existence/count checks: `returnCountOnly=true` is the cheapest way to size a result set before paging. Distinct values for building UI filters: `returnDistinctValues=true` with a single `outFields` field and `returnGeometry=false`. Fetching all OBJECTIDs first via `returnIdsOnly=true`, then batch-fetching attributes by `objectIds`, is the robust pattern when `resultOffset` paging is unsupported (older services lacking `supportsPagination`). Also covers related-record queries (`/queryRelatedRecords` with `relationshipId`) and attachment queries (`/queryAttachments`).

TODO: expand from authoritative source (developers.arcgis.com REST API query documentation and Esri community patterns).
