---
title: ogr2ogr Conversion Patterns
category: oss
topic_tags: [gdal, ogr2ogr, etl, format-conversion, reprojection]
status: stub
---

# ogr2ogr Conversion Patterns

`ogr2ogr` is the universal vector converter: syntax is `ogr2ogr -f <output_driver> <destination> <source> [layer]`, and it reads/writes Shapefile, GeoPackage, GeoJSON, PostGIS, FileGDB (via OpenFileGDB driver), Parquet, FlatGeobuf, CSV, and dozens more. Core flags: `-t_srs EPSG:3857` reprojects, `-s_srs` overrides a missing source CRS, `-where "pop > 1000"` attribute-filters, `-spat xmin ymin xmax ymax` spatially filters, `-sql "SELECT ..."` runs OGR SQL or (with `-dialect SQLITE`) SpatiaLite SQL against any source. Layer-shaping flags: `-nln new_layer_name`, `-nlt PROMOTE_TO_MULTI` (fixes mixed Polygon/MultiPolygon loads), `-select "field1,field2"`, `-mapFieldType` for type coercion, and `-lco`/`-dsco` for driver-specific layer/dataset creation options. Write modes: default create, `-overwrite` to replace a layer, `-append` to add rows, `-update` to open an existing datasource writable — the backbone of idempotent ETL. PostGIS loading example: `ogr2ogr -f PostgreSQL PG:"host=localhost dbname=dymaxion" parcels.gpkg -nln staging.parcels -lco GEOMETRY_NAME=geom --config PG_USE_COPY YES` (COPY mode is dramatically faster). It reads Esri Feature Services directly via the `ESRIJSON`/`OAPIF` drivers or a GeoJSON query URL, enabling REST-to-PostGIS pipelines. `-makevalid`, `-simplify <tolerance>`, and `-explodecollections` clean geometry inline during conversion.

TODO: expand from authoritative source (gdal.org/programs/ogr2ogr.html).
