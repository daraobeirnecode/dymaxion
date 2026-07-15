---
title: Apache Sedona and Wherobots
category: oss
topic_tags: [sedona, wherobots, spark, big-data, spatial-sql, h3]
status: stub
---

# Apache Sedona and Wherobots

Apache Sedona extends Spark (plus Flink and Snowflake) with spatial types, functions, indexes, and partitioners for cluster-scale analytics — the tool when a spatial join or point-in-polygon job outgrows a single PostGIS box into billions of rows. Usage from PySpark: `SedonaContext.create(spark)` registers ~300 SQL functions with PostGIS-compatible names (`ST_GeomFromWKT`, `ST_Intersects`, `ST_Transform`, `ST_H3CellIDs`, `ST_MakeValid`), so `spark.sql("SELECT ... FROM points p JOIN polys g ON ST_Contains(g.geom, p.geom)")` runs as a distributed spatial join backed by quadtree/KDB-tree partitioning and local indexes. Readers/writers cover GeoParquet (`spark.read.format("geoparquet")`), Shapefile, GeoJSON, and raster tiles (map-algebra functions `RS_*` handle imagery in DataFrames). H3 hexagon functions (`ST_H3CellIDs`, `ST_H3ToGeom`) enable the common pattern of hex-aggregating massive point data before visualizing. Wherobots is the commercial cloud built by Sedona's creators: managed serverless Sedona (WherobotsDB) with a spatial catalog, `Havasu` Iceberg-based spatial table format, raster inference (`RS_` ML functions), and notebook/job APIs — positioned like "Databricks for spatial". Sedona also runs fine on local Spark for development (`pip install apache-sedona[spark]`), and SedonaKepler/SedonaPyDeck give notebook visualization. Reach for Sedona/Wherobots at the petabyte/continental scale — full-planet OSM or Overture joins, national parcel × imagery workloads; below ~100M features prefer DuckDB Spatial or PostGIS for operational simplicity. Sedona's PostGIS-compatible function surface means SQL often ports between the engines with minimal edits.

TODO: expand from authoritative source (sedona.apache.org/latest/api/sql and wherobots.com/docs).
