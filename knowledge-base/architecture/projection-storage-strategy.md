---
title: "Projection Strategy: Store Geographic vs Projected, Multiple Representations"
category: architecture
topic_tags: [projection-strategy, storage-srid, reprojection, epsg-4326, materialized-views, schema-design]
status: stub
---

# Projection Strategy: Store Geographic vs Projected, Multiple Representations

The storage-CRS decision shapes every downstream query. Store-geographic (EPSG:4326, or PostGIS `geography`): one canonical representation, direct GeoJSON/API output, geodesic measurement correctness anywhere on earth — at the cost of slower geodesic functions, a reduced geography function set, and per-query `ST_Transform` for planar analysis. Store-projected (e.g. EPSG:26910 or 2226 for a Sacramento client): fast planar `ST_Area`/`ST_Buffer`/`ST_Intersects` in meaningful units and index-friendly analysis — at the cost of a validity boundary (data outside the zone distorts) and a transform step before web/API delivery (though `ST_AsMVT` pipelines transform to 3857 per-tile cheaply). The pragmatic default for regional work is projected storage in the project's working CRS, recorded in `dymaxion.projects.context`, with 4326 emitted at API boundaries; for global or multi-region datasets, geographic storage wins. Multiple stored representations are legitimate when read patterns diverge: a canonical `geom` column plus a generated projected copy (`geom_3857 geometry GENERATED ALWAYS AS (ST_Transform(geom, 3857)) STORED` in PostGIS 3+, each with its own GiST index) or materialized views per consumer — the rules are that exactly one column is canonical, derived copies are rebuilt mechanically, and no editor ever writes a derived column. Precompute expensive derivations (area_m2, centroid, H3 index) as columns rather than re-deriving in queries. Beware storing 3857 as the only representation: its area/distance distortion silently corrupts any analytics someone later runs on it. Whatever the choice, enforce it: `ALTER TABLE ... ADD CONSTRAINT enforce_srid CHECK (ST_SRID(geom) = 26910)` (typmod does this implicitly), so mixed-SRID rows cannot creep in. Document the transform pipeline (which grid, which datum realization) in dataset metadata — the projection strategy is only reproducible if the transformation is.

TODO: expand from authoritative source (PostGIS geometry vs geography and generated-columns docs; Esri geodatabase spatial reference guidance).
