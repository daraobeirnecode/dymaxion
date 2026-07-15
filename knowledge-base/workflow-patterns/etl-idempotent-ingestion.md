---
title: "ETL: Idempotent Ingestion with Upsert and Hash Detection"
category: workflow-patterns
topic_tags: [etl, idempotent, upsert, hashing, ingestion, postgres]
status: stub
---

# ETL: Idempotent Ingestion with Upsert and Hash Detection

An ingestion job is idempotent when running it twice against the same source produces the same database state — the property that makes retries, backfills, and cron overlaps safe. The core Postgres idiom is `INSERT ... ON CONFLICT (source_id) DO UPDATE SET ... WHERE excluded.row_hash IS DISTINCT FROM target.row_hash`, keyed on a stable natural key (GlobalID from a feature service, OSM id, parcel APN), never on an auto-increment. Compute `row_hash` as `md5(attrs::text || ST_AsEWKB(geom)::text)` (or `digest(..., 'sha256')` from pgcrypto) over a canonicalized record — sorted JSONB keys, geometry normalized with `ST_Normalize` or fixed-precision `ST_ReducePrecision` — so semantically identical rows hash identically. The hash guard means unchanged rows are skipped entirely, which keeps `updated_at` triggers, notify queues, and downstream CDC honest: only real changes propagate. Handle deletes explicitly with either soft deletes (`deleted_at` set when the source key vanishes from a full snapshot) or a reconciliation pass comparing source keys to target keys. Wrap each batch in one transaction and write a `load_runs` row (source, watermark, rows inserted/updated/skipped/deleted, hash of the batch) so a rerun can prove it was a no-op. GDAL's `ogr2ogr -upsert` (GDAL ≥ 3.6) provides the same semantics for file-based sources when the layer has a FID/unique constraint. Idempotency at ingestion is what allows bronze/silver rebuilds and CDC watermarks to be trusted downstream.

TODO: expand from authoritative source (PostgreSQL INSERT ON CONFLICT docs; GDAL ogr2ogr -upsert docs; pgcrypto digest reference).
