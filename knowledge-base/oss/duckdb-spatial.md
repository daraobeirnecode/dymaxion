---
title: DuckDB Spatial
category: oss
topic_tags: [duckdb, spatial, geoparquet, analytics, olap, st-functions]
status: stub
---

# DuckDB Spatial

DuckDB's spatial extension (`INSTALL spatial; LOAD spatial;`) adds a `GEOMETRY` type and PostGIS-style functions (`ST_Read`, `ST_Point`, `ST_Intersects`, `ST_Contains`, `ST_DWithin`, `ST_Transform`, `ST_Area`, `ST_AsGeoJSON`) to an in-process columnar OLAP engine — think "SQLite for analytics" with spatial superpowers. `ST_Read('file.gpkg')`/`ST_Read('file.shp')` table-functions ingest any GDAL-readable vector source, and GeoParquet is first-class: `SELECT * FROM read_parquet('s3://overturemaps-us-west-2/release/.../buildings/*.parquet') WHERE bbox.xmin > ...` streams remote partitioned data with predicate pushdown over HTTP ranges (via the `httpfs` extension), making DuckDB the standard tool for querying Overture Maps releases. Export with `COPY (SELECT ...) TO 'out.parquet' (FORMAT PARQUET)` or `ST_Write`-style GDAL copies to GPKG/GeoJSON/FlatGeobuf. Practical envelope: interactive analytics up to roughly 100M features on a laptop — spatial joins, aggregations, H3 hexbinning (community `h3` extension) — where PostGIS would need careful indexing and Spark would be overkill. It complements rather than replaces PostGIS: no concurrent-writer serving, no GIST-backed transactional workloads, no triggers — DuckDB is read-heavy/ETL, PostGIS is the system of record and tile source. Common Dymaxion-style pipeline: DuckDB filters and reshapes a huge GeoParquet dump, writes a slim Parquet/GPKG extract, then ogr2ogr or `ATTACH 'dbname=dymaxion' AS pg (TYPE postgres)` pushes results into PostGIS. Python integration is trivial (`duckdb.sql(...)` to/from pandas, Arrow, and GeoPandas via `ST_AsWKB`), and the CLI one-liner `duckdb -c "LOAD spatial; ..."` slots into shell ETL. RTree indexes exist for point-lookup acceleration, but most workloads rely on zone-map pruning of sorted/bboxed Parquet instead.

TODO: expand from authoritative source (duckdb.org/docs/stable/core_extensions/spatial/overview).
