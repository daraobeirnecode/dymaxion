---
slug: enterprise-gdb-connect
name: Enterprise GDB Connect
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Enterprise GDB Connect

## Purpose

Create (or reuse) an SDE connection file on the Windows Worker via arcpy and
run read-only operations against an enterprise geodatabase: describe a
dataset, run a SELECT query, or register the connection for later skills.
Strictly read-only — any DML/DDL in a query is rejected before it reaches
the database.

## When to use this skill

- User asks about data living in an enterprise geodatabase ("what's in
  gisprod.parcels", "row count of the tax_parcels table")
- A workflow needs an SDE connection registered in `dymaxion.datasets` so
  later runs can reference it by name

## When NOT to use this skill

- Writing to the geodatabase — requires a dedicated destructive skill with
  approval; this skill refuses all writes
- The database is reachable as PostGIS directly — use
  `postgis-spatial-query` (no worker round-trip needed)
- Hosted Feature Services — use `feature-service-query`

## Inputs

- `connection` (object, required): `{host, database, auth_ref, version}`;
  `auth_ref` names a SOPS-encrypted credential key — raw credentials are
  never accepted inline
- `query` (string, optional): SELECT-only SQL to execute
- `dataset` (string, optional): fully qualified dataset to describe
  (fields, row count, spatial reference)
- `register_as` (string, optional): name under which to persist the
  connection in `dymaxion.datasets`

## Outputs

- `connection_name` (string): worker-side .sde connection file name / the
  registered name
- `query_results` (object): rows (capped at 1000) or the dataset
  description, plus column labels

## Tools required

- `windows-worker` — hosts arcpy (`CreateDatabaseConnection`,
  `ArcSDESQLExecute`, `Describe`); reached over Tailscale

## Execution plan

1. Resolve `connection.auth_ref` from the SOPS-encrypted environment on the
   worker; fail if the key is absent — never accept inline passwords
2. Check host/database against `config/employer-boundary.yaml`; refuse
   denylisted hosts
3. Create or reuse the .sde connection file via
   `arcpy.management.CreateDatabaseConnection` (named by host+database hash)
4. If `query`: lint it — SELECT-only; reject INSERT/UPDATE/DELETE/DROP/
   TRUNCATE/ALTER/GRANT before execution
5. Execute via `ArcSDESQLExecute` (query) or `arcpy.Describe` +
   `GetCount` (dataset), capping results at 1000 rows
6. Classification-tier LLM writes a one-line label of what the result set
   contains
7. If `register_as`: upsert the connection metadata (no credentials) into
   `dymaxion.datasets`
8. Return `connection_name` + `query_results`

## LLM prompts

### Result labeling (classification tier)

System: You label database query results in one sentence: what the rows
represent, the row count, and the source table. No adjectives.

User: Query: {query}. Columns: {columns}. Row count: {row_count}. Source:
{database} on {host}. Write the one-line label.

## Failure modes

- SDE authentication failure — fail naming the `auth_ref` key that was
  used; never echo credential values into logs or errors
- Requested version not found — fail with the list of visible versions
  from `sde.versions`
- Worker offline — fail fast with the worker health endpoint; no silent
  queueing
- Query touches a schema blocked by the employer boundary — refuse and cite
  `config/employer-boundary.yaml`

## Cost + timeout

- Max cost per invocation: $0.10 (budget cap)
- Max duration: 600 seconds (arcpy worker ceiling; typical runs are far
  shorter)
- Typical actual cost: $0.05, typical duration: 10-30 seconds
