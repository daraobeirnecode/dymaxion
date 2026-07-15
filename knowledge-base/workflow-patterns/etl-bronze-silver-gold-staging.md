---
title: "ETL: Bronze/Silver/Gold Staging in PostGIS"
category: workflow-patterns
topic_tags: [etl, medallion, staging, postgis, data-pipeline, schemas]
status: stub
---

# ETL: Bronze/Silver/Gold Staging in PostGIS

The medallion pattern maps cleanly onto PostGIS schemas: `bronze` holds raw ingested records exactly as received (source JSON in a JSONB column, original SRID, load timestamp, source URI), `silver` holds validated and conformed features, and `gold` holds analysis- and publication-ready tables. Bronze loads are append-only — `ogr2ogr -f PostgreSQL -nln bronze.parcels_raw -lco GEOMETRY_NAME=geom` or a Feature Service page fetch — never edited, so any downstream table can be rebuilt from them. Silver transforms enforce the contract: `ST_MakeValid` on geometry, `ST_Transform` to the project working SRID, type casts, domain checks, deduplication on the source key, and rejection rows routed to a `silver.rejects` table with a reason column. Gold tables add derived columns (area via `ST_Area`, H3 index, joins to reference data), a GiST index (`CREATE INDEX ... USING gist (geom)`), and are the only layer GeoServer or Koop publishes from. Each layer transition is one idempotent SQL script or dbt model, so re-running a load produces identical output; record run metadata (row counts in/out/rejected, duration) in `dymaxion.audit_log`. Keep bronze retention explicit (e.g. 90 days of raw pages) since geometries in JSONB bloat quickly. This structure makes the "where did this attribute come from" question answerable with a lineage of at most three queries.

TODO: expand from authoritative source (Databricks medallion architecture docs adapted to PostGIS; PostGIS manual on schemas, ST_MakeValid, GiST indexing).
