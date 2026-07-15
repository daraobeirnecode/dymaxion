---
title: Feature Service Query Parameters (ArcGIS REST API)
category: esri
topic_tags: [rest-api, feature-service, query, where, outfields, spatialrel]
status: stub
---

# Feature Service Query Parameters (ArcGIS REST API)

Reference for the `/FeatureServer/{layerId}/query` endpoint and its most-used parameters. `where` takes a SQL-92 predicate (`STATUS = 'Active' AND POP2020 > 5000`; use `1=1` to select all). `outFields` is a comma-separated field list or `*`; requesting only needed fields materially cuts payload size. Spatial filtering combines `geometry` (JSON geometry or simple `xmin,ymin,xmax,ymax` envelope), `geometryType` (`esriGeometryEnvelope`, `esriGeometryPolygon`, `esriGeometryPoint`, etc.), `inSR`, and `spatialRel` (`esriSpatialRelIntersects` is the default; also `esriSpatialRelContains`, `esriSpatialRelWithin`, `esriSpatialRelEnvelopeIntersects`). `returnGeometry=false` speeds attribute-only queries; `outSR` reprojects returned geometry; `geometryPrecision` and `maxAllowableOffset` thin coordinates. Paging uses `resultOffset` and `resultRecordCount`, capped by the service's `maxRecordCount` (commonly 1000 or 2000). Other essentials: `orderByFields`, `returnCountOnly=true`, `returnIdsOnly=true`, `returnDistinctValues`, `outStatistics` with `groupByFieldsForStatistics`, `time` for time-enabled layers, and `f=json|geojson|pbf` output formats. Covers when to POST instead of GET (long where clauses or polygon geometry exceeding URL length limits).

TODO: expand from authoritative source (developers.arcgis.com/rest "Query (Feature Service/Layer)" reference).
