---
title: PostGIS Extension Setup
category: oss
topic_tags: [postgis, postgres, extensions, setup, spatial-database]
status: stub
---

# PostGIS Extension Setup

Enable PostGIS in a Postgres database with `CREATE EXTENSION postgis;`, which installs the `geometry`, `geography`, and `box2d/box3d` types plus the `spatial_ref_sys` table. Add `CREATE EXTENSION postgis_topology;` for the `topology` schema and `CREATE EXTENSION postgis_raster;` for raster support, which was split out of core in PostGIS 3.0. Optional companions include `postgis_sfcgal` for 3D operations (ST_3DIntersection, ST_Extrude), `fuzzystrmatch` + `postgis_tiger_geocoder` for US geocoding, and `address_standardizer`. Verify the install with `SELECT postgis_full_version();`, which reports the linked GEOS, PROJ, and GDAL versions. Upgrade in place with `SELECT postgis_extensions_upgrade();` after replacing binaries — never drop/recreate the extension on a populated database. On Debian/Ubuntu the packages are `postgresql-18-postgis-3` and `postgresql-18-postgis-3-scripts`; the official `postgis/postgis` Docker image ships everything preinstalled. The extension must be created per-database (or in `template1` to apply to future databases), and creating it requires superuser or a role with `CREATE` on the database in trusted-extension setups. In the Dymaxion stack, PostGIS coexists with pgvector and AGE in the same Postgres 18 cluster.

TODO: expand from authoritative source (postgis.net/docs — Chapter 3, Installation and Configuration).
