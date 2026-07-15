---
slug: sedona-spark-analytics
name: Sedona Spark Analytics
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Sedona Spark Analytics

## Purpose

Run distributed spatial SQL with Apache Sedona on a Spark cluster (local[N] or a
remote master over Tailscale) for workloads beyond single-node DuckDB: 100M+
features, continental joins, KNN joins, partitioned GeoParquet lakes. Registers
datasets as Sedona SQL temp views, executes, writes partitioned Parquet output,
and returns Spark job metrics.

## When to use this skill

- Spatial joins/aggregations over 100M+ features (e.g. all Overture buildings
  x admin areas)
- The data is already partitioned GeoParquet on disk/object storage
- `duckdb-spatial-analytics` hit memory/time limits on the same question

## When NOT to use this skill

- Under ~100M features on one machine → `duckdb-spatial-analytics` is cheaper
  and has no cluster spin-up cost
- No local/remote Spark available and the workload is huge → `wherobots-cloud-query`
- Interactive, iterative exploration — Spark job latency makes iteration slow;
  prototype on a sample in DuckDB first, then scale up here

## Inputs

- `sql` (string, required): Sedona Spark SQL referencing dataset view names
- `datasets` (array, required): `[{name, path, format}]`; format ∈ `geoparquet |
  parquet | csv | shapefile`
- `spark_master` (string, optional, default `local[8]`): Spark master URL,
  e.g. `local[8]` or `spark://spark-master:7077`
- `output_path` (string, optional): Parquet output directory; a scratch path is
  generated when omitted

## Outputs

- `output_path` (string): directory of the written Parquet result
- `job_metrics` (object): `{row_count, duration_ms, stages, shuffle_read_bytes,
  shuffle_write_bytes, executor_config, partitions_written}`

## Tools required

- `pyspark` — SparkSession management + job submission
- `sedona` — Sedona spatial SQL functions, spatial partitioning + join optimization

## Execution plan

1. Validate dataset paths/permissions; peek row counts and CRS from GeoParquet
   metadata; estimate the join cardinality (reasoning-tier LLM sanity check on
   the plan: is the join key spatial, is a broadcast of the small side viable?)
2. Build the SparkSession against `spark_master` with SedonaContext; set
   sensible defaults (`spark.sql.adaptive.enabled`, Kryo + Sedona serializers)
3. Register each dataset as a temp view; for csv/shapefile, apply explicit
   schema/geometry construction
4. Dry-run the SQL through the analyzer (`spark.sql(sql).explain()`); if the
   plan shows a cartesian product, abort and restructure before burning cluster
   time
5. Execute; write results to `output_path` as Parquet (partitioned when result
   > 10M rows)
6. Collect Spark metrics from the listener (stages, shuffle volumes, duration)
7. Stop the session; return `output_path` + `job_metrics` with concrete numbers

## LLM prompts

### Review the query plan before execution (reasoning tier)

System: You are a Sedona/Spark spatial query reviewer. Given dataset sizes and
an EXPLAIN plan, decide: proceed, broadcast the smaller side, add spatial
partitioning hints, or abort (cartesian product). Answer JSON:
{"decision": "proceed"|"revise"|"abort", "revised_sql": ..., "reasoning": ...}.
Frame recommendations with tradeoffs; never claim certainty.

User: Datasets: {dataset_stats}. SQL: {sql}. Plan: {explain_output}.
Cluster: {spark_master}, {executor_summary}.

## Failure modes

- Spark master unreachable → fail fast with the master URL and a hint to check
  the Tailscale route / container; do not silently fall back to local mode with
  a huge dataset
- Executor OOM mid-job → capture the failing stage, recommend spatial
  partitioning (`GridType.KDBTREE`) or a coarser pre-filter; job output
  directory is cleaned so no partial results leak downstream
- Analyzer detects cartesian product → abort before execution (step 4), return
  the revised-SQL suggestion from the reasoning review
- CRS mismatch across datasets → abort with per-dataset CRS listed and the
  exact ST_Transform to add

## Cost + timeout

- Max cost per invocation: $0.60
- Max duration: 900 seconds
- Typical actual cost: $0.30, typical duration: 2-10 minutes
