---
slug: wherobots-cloud-query
name: Wherobots Cloud Query
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Wherobots Cloud Query

## Purpose

Execute read-only spatial SQL against a Wherobots Cloud workspace (managed
SedonaDB): scale-out queries over workspace catalogs and the Wherobots open
data catalog (Overture, etc.) without operating a Spark cluster. Query-only —
no writes to workspace catalogs — and every run reports Wherobots compute cost
alongside LLM cost.

## When to use this skill

- Workloads beyond the local Sedona cluster's practical capacity, or when no
  local cluster is running
- Querying datasets already hosted in the Wherobots workspace or its open data
  catalog (avoids a large download entirely)
- Getting planetary-scale answers (e.g. Overture buildings by class over a
  country) with a per-query cost cap

## When NOT to use this skill

- The data is local and under ~100M features → `duckdb-spatial-analytics`;
  cloud compute + upload beats nothing here
- The job must write/persist tables in the workspace — out of scope for this
  query-only skill; propose a separate destructive skill if needed
- Data cannot leave the local environment (employer boundary / sensitivity) —
  keep it on `sedona-spark-analytics`

## Inputs

- `sql` (string, required): Sedona-flavored Spark SQL (SELECT only)
- `workspace` (string, required): Wherobots workspace name; credentials come
  from the SOPS-encrypted env, never inline
- `runtime_size` (string, optional, default `small`): `small | medium | large`
  runtime tier; larger tiers require the run's cost estimate to be surfaced
- `output_format` (string, optional, default `json`): `json | geojson | wkt`
  serialization for geometry columns in the returned rows

## Outputs

- `results` (array): result rows (capped at 10,000; larger results are
  rejected with guidance to aggregate)
- `run_metadata` (object): `{row_count, duration_ms, runtime_size,
  wherobots_compute_cost_usd, session_id, truncated}`

## Tools required

- `wherobots-cli` — session/runtime lifecycle against the workspace
- `http` — Wherobots SQL API calls + result retrieval

## Execution plan

1. Lint the SQL: single SELECT only; reject DDL/DML/`CREATE TABLE AS`
2. Authenticate via wherobots-cli using the stored API key; resolve the
   workspace and confirm the requested `runtime_size` is allowed by config
3. Start (or attach to) a SQL session on the runtime tier; record session id
4. Submit the query with a server-side timeout below the skill budget (840 s)
5. Fetch results; serialize geometry per `output_format`; cap at 10,000 rows
   and set `truncated` accordingly
6. Read the session's compute-cost meter; tear down the session unless another
   queued invocation will reuse it within 5 minutes
7. Return rows + `run_metadata` including Wherobots compute cost in USD

## LLM prompts

### Adapt SQL to Wherobots catalogs (workhorse tier)

System: You adapt spatial SQL to Wherobots SedonaDB. Fully qualify tables as
catalog.schema.table using the provided catalog listing. Geometry column is
"geometry" in Wherobots open data. Use Sedona ST_* functions. SELECT only.
Output SQL only.

User: Catalog listing: {catalog_json}. Question or draft SQL: {input_sql}.

## Failure modes

- Auth failure / expired API key → fail before starting a paid session; point
  at the SOPS env entry for the Wherobots key
- Runtime startup exceeds 5 minutes → cancel the session (avoid idle billing),
  report Wherobots status, suggest retry or a smaller runtime tier
- Query cancelled at the 840 s server timeout → return partial metadata with
  the session id and the compute cost actually incurred; recommend aggregating
  or tiling the AOI
- Result exceeds the 10,000-row cap → reject with the true count and a concrete
  rewrite suggestion (GROUP BY or server-side export) instead of truncating a
  non-aggregated result silently

## Cost + timeout

- Max cost per invocation: $0.30 (LLM) + metered Wherobots compute (reported
  per run in `run_metadata.wherobots_compute_cost_usd`)
- Max duration: 900 seconds
- Typical actual cost: $0.15 + Wherobots compute, typical duration: 1-8 minutes
