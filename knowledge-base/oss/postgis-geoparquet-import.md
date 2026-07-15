---
title: Importing GeoParquet into PostGIS
category: oss
topic_tags: [geoparquet, postgis, ogr2ogr, parquet, data-import]
status: stub
---

# Importing GeoParquet into PostGIS

GDAL >= 3.5 built with Arrow/Parquet support reads GeoParquet natively as the `Parquet` OGR driver, so import is a one-liner: `ogr2ogr -f PostgreSQL PG:"dbname=dymaxion" buildings.parquet -nln buildings -lco GEOMETRY_NAME=geom -lco FID=id -nlt PROMOTE_TO_MULTI`. Confirm driver availability with `ogrinfo --formats | grep -i parquet`. Add `-t_srs EPSG:4326` (or a target SRID) to reproject during load; GeoParquet 1.0 files declare their CRS in the `geo` metadata key so `-s_srs` is rarely needed. Remote files work through VSI: `ogr2ogr -f PostgreSQL PG:"..." /vsis3/bucket/overture/buildings.parquet` or `/vsicurl/https://...`, and Overture Maps releases are the canonical large-scale GeoParquet source. For partitioned datasets pass the directory and GDAL unions the fragments, or filter early with `-spat xmin ymin xmax ymax` and `-where` to avoid pulling the whole file. An alternative path is DuckDB: `INSTALL spatial; LOAD spatial;` then `COPY (SELECT ... FROM read_parquet('...')) TO ...` or ATTACH to Postgres, which can be faster for column-selective loads. After import, create the GIST index and run `ANALYZE` — ogr2ogr creates a spatial index by default unless `-lco SPATIAL_INDEX=NONE`. Export back out with `ogr2ogr -f Parquet out.parquet PG:"dbname=dymaxion" -sql "SELECT ..."` with `-lco COMPRESSION=ZSTD`.

TODO: expand from authoritative source (gdal.org/drivers/vector/parquet.html and geoparquet.org).
