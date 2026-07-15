---
slug: postgis-schema-migrate
name: PostGIS Schema Migrate
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# PostGIS Schema Migrate

## Purpose

Apply a DDL migration to a PostGIS database — create tables, add spatial
indexes, alter columns/constraints, register geometry columns. Destructive by
definition: every run requires explicit operator approval, executes inside a
transaction, and produces a rollback script.

## When to use this skill

- Creating a new spatial table with a typed geometry column and GIST index
- Adding/dropping indexes or constraints on existing spatial tables
- Structured schema evolution: renames, type changes, SRID corrections via
  `ALTER TABLE ... ALTER COLUMN geom TYPE geometry(..., srid)`

## When NOT to use this skill

- Read-only questions about the schema — use `postgis-spatial-query` against
  `information_schema` / `geometry_columns`
- Bulk data loads (COPY/INSERT) — that is data movement, not schema; use
  `gdal-format-convert` with a PG target or a pipeline skill
- Anything touching the `dymaxion.*` runtime schema — off-limits to skills
  outside their declared write scope

## Inputs

- `migration_sql` (string, required): the DDL statements to apply
- `database` (string, required): named connection registered with postgres-mcp
- `dry_run` (boolean, optional, default false): validate + plan + generate
  rollback, but ROLLBACK instead of COMMIT
- `description` (string, optional): human summary stored in the audit log

## Outputs

- `migration_result` (object): `{applied, statements, duration_ms, dry_run,
  objects_changed}`
- `rollback_sql` (string): best-effort inverse DDL (DROP for CREATE, etc.)

## Tools required

- `postgres-mcp` — transactional DDL execution

## Execution plan

1. Parse `migration_sql` into individual statements; classify each (CREATE /
   ALTER / DROP / CREATE INDEX / other). Reject DML (INSERT/UPDATE/DELETE) and
   any statement targeting the `dymaxion` schema
2. Generate rollback SQL per statement (LLM step for non-trivial ALTERs);
   statements without a safe inverse are flagged `irreversible: true`
3. Present the migration + rollback + irreversibility flags as an approval
   request; block until approved (skipped only for `dry_run: true`)
4. BEGIN; run each statement; capture per-statement timing and affected objects
5. `dry_run` → ROLLBACK and report what would have happened; else COMMIT
6. Record the migration in the audit log with `description`, SQL, and rollback
7. Return `migration_result` + `rollback_sql`

## LLM prompts

### Generate rollback DDL (workhorse tier)

System: You write PostgreSQL rollback DDL. For each forward statement produce
the exact inverse statement, or the token IRREVERSIBLE if no lossless inverse
exists (e.g. DROP TABLE, type narrowing). Output a JSON array aligned with the
input statements. No commentary.

User: Forward statements: {statements_json}. Current schema for affected
objects: {schema_snippets}.

## Failure modes

- A statement fails mid-migration → transaction rolls back automatically; report
  the failing statement index and Postgres error verbatim; nothing is partially
  applied
- Lock wait on a busy table exceeds 30s (`lock_timeout`) → abort, report which
  session holds the lock, recommend re-running in a maintenance window
- Migration contains an irreversible statement and the operator was not warned
  → hard-block before execution; approval text must include the IRREVERSIBLE flag
- Rollback generation uncertain (complex ALTER) → still apply if approved, but
  set `rollback_sql` to a comment explaining what manual inverse is required

## Cost + timeout

- Max cost per invocation: $0.16
- Max duration: 300 seconds
- Typical actual cost: $0.08, typical duration: 5-30 seconds
