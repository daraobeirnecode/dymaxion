---
slug: data-pipeline-design
name: Data Pipeline Design
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Data Pipeline Design

## Purpose

Design an ETL pipeline for spatial data: source assessment, staging,
transformation, quality checks, and publication. Produces an architecture doc
framed as "recommend, with tradeoffs" plus an n8n workflow scaffold saved to
the workspace. Design only — nothing is deployed or executed.

## When to use this skill

- User asks to design/plan a recurring spatial data load or sync
- Multiple sources must be merged, cleaned, and published on a schedule
- An ad-hoc manual process needs to become a repeatable pipeline

## When NOT to use this skill

- One-off format conversion (use `gdal-format-convert`)
- Pipeline already designed and a single step needs implementing (use the
  relevant query/convert/publish skill)
- The decision is only about storage or serving, not flow
  (use `database-choice-decide` / `tile-server-decide`)

## Inputs

- `source_descriptions` (array, required): one entry per source — format,
  location, update cadence, quirks
- `target_description` (string, required): where the data must land and what
  consumes it
- `update_frequency` (string, optional): e.g. "nightly", "hourly", "on-demand"
- `quality_requirements` (string, optional): validity rules, referential
  integrity, completeness thresholds

## Outputs

- `architecture_doc` (string): Markdown pipeline design — stage-by-stage,
  with tradeoffs on orchestration and transformation choices
- `n8n_workflow_path` (string): absolute path to the generated n8n workflow
  JSON scaffold in the workspace
- `pipeline_stages` (array): ordered stage entries
  (`{stage, tool, input, output, quality_checks}`)

## Tools required

- `filesystem-mcp` — to write the n8n workflow scaffold JSON to the workspace

## Execution plan

1. Validate `source_descriptions` (non-empty array) and `target_description`;
   fail with a clear error otherwise
2. Assess each source: format, access method, expected volume, cadence,
   failure characteristics (flaky SFTP, rate-limited API, etc.)
3. Call the reasoning-tier LLM with the system prompt below to draft the
   staged design: extract → stage → transform → quality-check → publish,
   with explicit tradeoffs (e.g. GDAL vs SQL transforms, truncate-reload vs
   incremental upsert)
4. Derive `pipeline_stages` as a structured list from the draft
5. Generate an n8n workflow scaffold (trigger node per `update_frequency`,
   one node per stage, error branch to a notification node) and write it via
   filesystem-mcp to `/workspace/data/pipelines/{slug}-{date}.n8n.json`
6. Return doc, workflow path, and stages; log run to
   `dymaxion.skill_invocations`

## LLM prompts

### Draft pipeline design

System: You are a spatial ETL architect. You recommend, with tradeoffs — you
never claim certainty. Design pipelines with an explicit staging area; never
transform directly into the target. Every stage names its tool, its inputs
and outputs, and its failure behavior (retry, skip, halt). Quality checks are
concrete and executable (SQL predicates, ogrinfo checks), not aspirations.
Call out where an incremental load beats truncate-reload and vice versa.
State assumptions for missing inputs. No emoji.

User: Sources: {source_descriptions}. Target: {target_description}.
Frequency: {update_frequency}. Quality requirements: {quality_requirements}.
Produce a Markdown pipeline design with sections: Overview, Source
assessment, Stages (extract/stage/transform/quality/publish), Failure and
retry policy, Orchestration tradeoffs, Assumptions.

### Generate n8n scaffold

System: You emit only valid n8n workflow JSON. One trigger node matching the
stated frequency, one node per pipeline stage in order, an error branch to a
notification placeholder node. Node names match the stage names exactly.
No credentials, no live endpoints — placeholders only.

User: Stages: {pipeline_stages}. Frequency: {update_frequency}.
Emit the n8n workflow JSON.

## Failure modes

- `source_descriptions` empty or missing → fail fast asking for one entry
  per source with format and cadence
- n8n scaffold JSON fails to parse → retry generation once; on second
  failure return the architecture doc with `n8n_workflow_path: ""` and a
  warning rather than failing the whole run
- filesystem-mcp write refused (path outside workspace) → retry into the
  default `/workspace/data/pipelines/` location and note the relocation
- Sources are described too vaguely to assess → produce the design with an
  explicit "Unverified source assumptions" section instead of guessing silently

## Cost + timeout

- Max cost per invocation: $1.00
- Max duration: 180 seconds
- Typical actual cost: $0.50, typical duration: 70 seconds
