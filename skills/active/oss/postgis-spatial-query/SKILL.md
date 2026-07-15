---
slug: postgis-spatial-query
name: PostGIS Spatial Query
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# PostGIS Spatial Query

## Purpose

Execute a read-only spatial SQL query against a PostGIS database and return the
result rows (geometries as GeoJSON) plus execution metadata: row count, runtime,
geometry types, SRIDs. Enforces read-only at the session level — this skill can
never mutate data.

## When to use this skill

- Ad-hoc spatial questions answerable with SQL: intersections, buffers, nearest
  neighbours, area/length aggregates, attribute filters
- Feeding downstream skills (e.g. counts before a `geoserver-publish`, source
  checks before `postgis-schema-migrate`)
- Translating a natural-language spatial question into SQL, then running it

## When NOT to use this skill

- Any INSERT/UPDATE/DELETE/DDL — use `postgis-schema-migrate` (DDL) or a
  dedicated edit skill; this skill runs in a read-only transaction and will fail
- Dataset lives in GeoParquet files, not Postgres — use
  `duckdb-spatial-analytics`
- Result set is analytical at the 10M+ row scale — aggregate in
  `duckdb-spatial-analytics` or `sedona-spark-analytics`

## Inputs

- `sql` (string, required): a single SELECT (or WITH...SELECT) statement
- `connection` (string, optional, default `gisdb`): named connection registered
  with postgres-mcp
- `max_rows` (number, optional, default 1000): hard cap appended as LIMIT if absent
- `explain` (boolean, optional, default false): also return EXPLAIN ANALYZE output

## Outputs

- `rows` (array): result rows; geometry columns serialized as GeoJSON
- `metadata` (object): `{row_count, duration_ms, columns, srids, truncated, explain}`

## Tools required

- `postgres-mcp` — parameterized query execution against registered connections

## Execution plan

1. Lint the SQL: reject anything that is not a single SELECT/WITH statement
   (no semicolon-chained statements, no DDL/DML keywords at statement position)
2. Open the session with `SET TRANSACTION READ ONLY` and
   `statement_timeout = 50s`
3. If `max_rows` given and query has no LIMIT, wrap it:
   `SELECT * FROM (<sql>) q LIMIT <max_rows+1>` to detect truncation
4. Execute; convert geometry columns via `ST_AsGeoJSON`; record SRIDs per column
5. If `explain: true`, run EXPLAIN (ANALYZE, BUFFERS) separately and attach
6. Return rows + metadata with concrete counts and timing

## LLM prompts

### Natural language to spatial SQL (workhorse tier)

System: You write a single read-only PostGIS SELECT statement. Use only tables
and columns from the provided schema. Use geometry functions correctly
(ST_Intersects, ST_DWithin with meters requires geography or projected CRS).
Always include a LIMIT. Output SQL only, no commentary.

User: Schema: {schema_json}. SRIDs: {srid_map}. Question: {user_question}.

## Failure modes

- SQL lint rejects the statement (write keywords detected) → fail immediately
  with the offending token; suggest `postgis-schema-migrate` if it was DDL
- statement_timeout exceeded → return the EXPLAIN plan of the killed query and
  recommend an index (`USING GIST (geom)`) or a smaller extent
- Mixed/missing SRIDs cause `ST_Intersects` error → detect SRID mismatch from
  the Postgres error, retry once wrapping one side in `ST_Transform`, and note
  the transform in metadata
- Result exceeds `max_rows` → return the first `max_rows` rows with
  `metadata.truncated: true`, never silently drop the fact

## Cost + timeout

- Max cost per invocation: $0.10
- Max duration: 60 seconds
- Typical actual cost: $0.05, typical duration: 2-10 seconds
