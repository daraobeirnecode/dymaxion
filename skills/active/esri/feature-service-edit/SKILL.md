---
slug: feature-service-edit
name: Feature Service Edit
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Feature Service Edit

## Purpose

Apply adds, updates, and deletes to a Feature Service layer via `applyEdits`,
after presenting the operator a before/after change summary and receiving
explicit approval. Destructive: this writes to production data.

## When to use this skill

- User explicitly asks to change features: fix an attribute, add a point,
  delete records
- A workflow has produced corrected values and the user asked for them to be
  applied to the service

## When NOT to use this skill

- Creating a brand-new layer or service — use `feature-layer-publish`
- Schema changes (add field, change domain) — not supported; requires a
  dedicated admin skill
- The service is not on the employer-boundary allowlist — refuse outright
- User only wants to see what would change — run `feature-service-query`
  and present a dry-run diff instead

## Inputs

- `service_url` (string, required): Feature Service root URL
- `layer_id` (number, required): target layer index
- `edits` (object, required): `{adds: [feature], updates: [feature],
  deletes: [objectId]}` in Esri feature JSON
- `rollback_on_failure` (boolean, optional): pass through to `applyEdits`.
  Default true

## Outputs

- `edit_results` (object): per-operation results — objectIds applied,
  per-feature success/error from the server
- `summary` (string): what changed, in operator voice, with counts

## Tools required

- `esri-mcp` — `query` (pre-edit state) and `applyEdits` operations

## Execution plan

1. Validate allowlist membership and `edits` shape; count adds/updates/deletes
2. Query current attributes of every feature referenced in `updates` and
   `deletes` (by objectId) to capture the before-state
3. Workhorse LLM drafts the approval summary: per-feature before → after,
   deletes listed prominently
4. Send approval request via the originating gateway; block until answered
   (timeout 15 minutes)
5. On approval, call `applyEdits` with `rollbackOnFailure` as configured
6. Verify server results; collect applied objectIds and any per-feature errors
7. Write the before/after diff to `dymaxion.audit_log`
8. Return `edit_results` + `summary`

## LLM prompts

### Approval summary (workhorse tier)

System: You draft pre-approval change summaries for GIS edits. List every
affected feature: objectId, before value, after value. Put deletes first
under a DELETES heading. Factual, no adjectives, no reassurance.

User: Target: layer {layer_id} of {service_url}. Proposed edits:
{edits_json}. Current values of affected features: {before_json}. Draft the
approval summary.

## Failure modes

- Approval denied or 15-minute timeout — abort; nothing is applied; log the
  denial in `dymaxion.audit_log`
- Partial success with `rollback_on_failure=false` — report per-feature
  failures and list exactly which objectIds were applied so the operator can
  reconcile
- Feature locked by an SDE version or concurrent editor — retry once after
  10s, then fail with the lock/version detail from the server
- `applyEdits` returns success=false for all features — surface the server
  error verbatim; do not retry (usually a schema or domain violation)

## Cost + timeout

- Max cost per invocation: $0.10 (budget cap)
- Max duration: 120 seconds (excluding operator approval wait)
- Typical actual cost: $0.05, typical duration: 15 seconds + approval wait
