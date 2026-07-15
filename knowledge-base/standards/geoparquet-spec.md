---
title: GeoParquet Specification
category: standards
topic_tags: [geoparquet, parquet, columnar, analytics, duckdb, cloud-native]
status: stub
---

# GeoParquet Specification

GeoParquet (OGC, 1.0 released 2023, 1.1 in 2024) standardizes geospatial vector data in Apache Parquet: geometry travels as a WKB (or, in 1.1, the columnar GeoArrow "native" encoding) column, and a `geo` key in the Parquet file metadata declares version, primary geometry column, geometry types, CRS (as PROJJSON, defaulting to OGC:CRS84), and optional per-file bbox. Being Parquet, it inherits columnar compression, predicate pushdown, and column pruning — reading two attributes of a 100M-row layer touches a fraction of the bytes a GeoPackage scan would — and 1.1's optional bbox covering column (struct of xmin/ymin/xmax/ymax) enables spatial predicate pushdown over row groups, letting engines skip chunks that cannot intersect a query window. The toolchain is broad: GDAL ≥ 3.5 (`ogr2ogr -f Parquet`), GeoPandas `read_parquet`/`to_parquet`, DuckDB's spatial extension (`SELECT ... FROM 'file.parquet' WHERE ST_Intersects(...)`, including over HTTP), Apache Sedona and BigQuery for warehouse scale, and QGIS via GDAL. It is the emerging archive/analytics format of the cloud-native stack: Overture Maps releases its planet datasets as GeoParquet on S3/Azure, and the pattern "GeoParquet in object storage + DuckDB/warehouse for analytics + PostGIS for serving" is rapidly becoming standard. Partitioning conventions (Hive-style directories, often by admin unit or quadkey/H3 cell) plus row-group-level bboxes make S3 scans of country-scale data practical without any database. It is not an editing or serving format — no indexes for point lookups, immutable files — so pair it with PostGIS or PMTiles for those tiers. For Dymaxion pipelines, GeoParquet is the correct bronze/archive layer format for large vector snapshots and the interchange format for warehouse handoffs.

TODO: expand from authoritative source (geoparquet.org spec; OGC GeoParquet standard; GDAL Parquet driver and DuckDB spatial docs).
