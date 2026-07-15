---
slug: database-choice-decide
name: Database Choice Decide
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Database Choice Decide

## Purpose

Recommend a spatial database — PostGIS, MSSQL Spatial, DuckDB Spatial, or
SpatiaLite — for a described workload, considering scale, budget, licensing,
and team skills. Returns an architecture doc framed as "recommend, with
tradeoffs" — never a claim of certainty.

## When to use this skill

- User asks "which spatial database should I use?"
- User is starting a project and needs a storage decision before schema design
- User is questioning whether their current spatial database still fits
  (scale, licensing, or team change)

## When NOT to use this skill

- Database already chosen and the user needs queries or migrations
  (use `postgis-spatial-query` / `postgis-schema-migrate`)
- Question is analytics-engine-shaped rather than system-of-record-shaped
  and clearly ephemeral (just run `duckdb-spatial-analytics`)
- Deployment/orchestration question (use `deployment-topology-decide`)

## Inputs

- `workload_description` (string, required): free-text description — editing
  patterns, concurrency, read/write mix, integration targets
- `data_volume_gb` (number, optional): approximate data volume in GB
- `team_skills` (array, optional): technologies the team already knows,
  e.g. `["postgresql", "python"]`
- `licensing_constraints` (string, optional): e.g. "no per-core commercial licensing"
- `budget_constraint` (string, optional): e.g. "open source strongly preferred"

## Outputs

- `architecture_doc` (string): Markdown doc with a primary recommendation,
  alternatives, and explicit tradeoffs per candidate
- `recommended_database` (string): one of `postgis`, `mssql-spatial`,
  `duckdb-spatial`, `spatialite`
- `tradeoffs` (array): structured tradeoff entries
  (`{option, pros, cons, licensing_note}`)

## Tools required

- None. Pure reasoning skill — no MCP or CLI tools.

## Execution plan

1. Validate `workload_description` present; fail with clear error otherwise
2. Classify workload shape: multi-user transactional, single-user desktop,
   embedded/file-based, or analytical batch
3. Score the four candidates against scale, concurrency, licensing cost,
   ecosystem fit, and `team_skills` overlap
4. Call the reasoning-tier LLM with the system prompt below to draft the
   architecture doc
5. Extract `recommended_database` and structured `tradeoffs` from the draft
6. Return doc + structured fields; log run to `dymaxion.skill_invocations`

## LLM prompts

### Draft database recommendation

System: You are a spatial database architect. You recommend, with tradeoffs —
you never claim certainty. For each candidate (PostGIS, MSSQL Spatial, DuckDB
Spatial, SpatiaLite) state where it wins and where it loses for THIS workload.
Weight team skills heavily: a familiar database run well usually beats an
unfamiliar one run poorly — say so when it applies. Be concrete about
licensing and operational cost. State assumptions for any missing input.
No emoji.

User: Workload: {workload_description}. Data volume: {data_volume_gb} GB.
Team skills: {team_skills}. Licensing: {licensing_constraints}.
Budget: {budget_constraint}. Produce a Markdown architecture doc with
sections: Recommendation, Why, Per-candidate tradeoffs, Licensing and cost
notes, Migration/exit considerations, Assumptions.

## Failure modes

- `workload_description` missing → fail fast asking for concurrency, data
  volume, and licensing constraints
- Workload genuinely straddles two candidates (e.g. transactional + heavy
  analytics) → recommend a primary system of record plus a companion engine,
  and flag the added operational cost explicitly
- LLM output missing a parseable database choice → retry once demanding a
  final `RECOMMENDED: <database>` line; else return
  `recommended_database: "undetermined"` with the doc intact

## Cost + timeout

- Max cost per invocation: $0.60
- Max duration: 180 seconds
- Typical actual cost: $0.30, typical duration: 40 seconds
