---
slug: duckdb-spatial-analytics
name: DuckDB Spatial Analytics
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# DuckDB Spatial Analytics

## Purpose

Run single-node, large-scale spatial SQL with the DuckDB `spatial` extension:
GeoParquet scans, spatial joins, aggregations, H3-style binning — comfortably up
to ~100M features on the host. Registers named sources as views, executes the
query, writes results to Parquet/GeoParquet, and returns a preview plus runtime
stats.

## When to use this skill

- Analytics too big for `postgis-spatial-query` but that still fit one machine
  (10M-100M features)
- The data already lives in (Geo)Parquet/CSV files — no load step needed
- Spatial join + group-by workloads: counts per polygon, nearest joins,
  extent stats, dedup across large delivery files

## When NOT to use this skill

- 100M+ features or the host runs out of memory → `sedona-spark-analytics`
  (local cluster) or `wherobots-cloud-query` (cloud)
- Data lives only in PostGIS and is small — `postgis-spatial-query` avoids the
  export hop
- Transactional edits or serving — DuckDB here is analytical scratch only

## Inputs

- `sql` (string, required): DuckDB SQL; reference sources by their registered
  view names
- `sources` (array, optional): `[{name, path}]` files (GeoParquet, Parquet,
  CSV, GeoPackage via ST_Read) registered as views before execution
- `output_path` (string, optional): write full results to this Parquet/
  GeoParquet path; only a preview is returned inline when omitted
- `memory_limit` (string, optional, default `8GB`): DuckDB memory ceiling

## Outputs

- `result_path` (string): path of the written result file (empty if not written)
- `result_preview` (array): first 50 result rows, geometries as WKT
- `stats` (object): `{row_count, duration_ms, memory_limit, source_row_counts,
  spilled_to_disk}`

## Tools required

- `duckdb` — DuckDB CLI/engine with `spatial` (and `httpfs` for allowlisted
  remote Parquet) extensions

## Execution plan

1. Verify each source path exists (or is an allowlisted remote URL); create the
   database with `SET memory_limit`, `SET temp_directory` for spill
2. `INSTALL/LOAD spatial`; register each source: `CREATE VIEW <name> AS
   SELECT * FROM read_parquet('<path>')` (or `ST_Read` for GDAL formats)
3. Lint the SQL read-only (no COPY to arbitrary paths, no ATTACH of
   non-declared databases)
4. `EXPLAIN` first; sanity-check the plan mentions the expected sources
5. Execute; if `output_path` set, run as `COPY (<sql>) TO '<output_path>'
   (FORMAT PARQUET)`; else fetch up to 50 preview rows directly
6. Collect per-source row counts + timing; report whether the query spilled
7. Return preview + stats with concrete numbers

## LLM prompts

### Draft DuckDB spatial SQL from an analytical question (workhorse tier)

System: You write DuckDB SQL using the spatial extension. Views available are
listed with their columns. Use ST_* functions (ST_Within, ST_Intersects,
ST_Area). Geometry columns are named geom unless stated. Output SQL only.

User: Views: {views_and_columns}. Question: {user_question}. Result should be
written to Parquet, so no LIMIT unless the question asks for top-N.

## Failure modes

- Out-of-memory despite the limit (join explosion) → report the failing
  operator from EXPLAIN, suggest pre-filtering by bbox or a two-stage join;
  do not silently raise the memory limit
- Source file has no CRS metadata / mixed CRS across sources → warn with the
  detected CRS per source before joining; abort if two joined sources disagree
  and no ST_Transform is present in the SQL
- Query exceeds the 900 s budget → cancel, return the EXPLAIN plan and the
  per-source row counts so the query can be restructured
- `output_path` already exists → fail before executing; never overwrite a
  result file without a new path

## Cost + timeout

- Max cost per invocation: $0.20
- Max duration: 900 seconds
- Typical actual cost: $0.10, typical duration: 30-300 seconds
