---
slug: skill-archive
name: Skill Archive
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Skill Archive

## Purpose

Archive a skill that has not been used in over 6 months and has a
lower-than-average success rate: move its folder from `skills/active/` to
`skills/archived/` and deregister it. Destructive (it changes the live skill
catalog), so the runtime always prompts the operator for approval first.

## When to use this skill

- Scheduled library hygiene flags a skill as stale (no invocations > 6
  months) and underperforming (success rate below library average)
- The operator explicitly asks to retire a skill
- A skill has been superseded by an approved replacement and should leave the
  active catalog

## When NOT to use this skill

- The skill is failing but still needed (use `skill-improve`)
- The skill is seasonal or intentionally rare (e.g. annual reporting) — low
  usage alone is not staleness; check `dymaxion.preferences` for exemptions
- The target is under `skills/proposed/` — proposed skills are rejected via
  the review flow, not archived

## Inputs

- `skill_slug` (string, required): slug of the skill under `skills/active/`
- `dry_run` (boolean, optional): if true, evaluate criteria and report what
  would happen without moving anything; default false

## Outputs

- `archived_path` (string): absolute destination path under
  `skills/archived/` (empty for dry runs and refusals)
- `archive_report` (object): `{eligible, last_used_at, success_rate,
  library_avg_success_rate, action_taken, reason}`

## Tools required

- `filesystem-mcp` — move the skill folder from `skills/active/` to
  `skills/archived/`

## Execution plan

1. Verify `skills/active/<skill_slug>/` exists; fail with the exact path
   otherwise
2. Query `dymaxion.skill_invocations` for last-used timestamp and success
   rate; compute the library-average success rate
3. Classify eligibility (classification-tier LLM assist for borderline
   cases): unused > 6 months AND success rate below library average
4. If not eligible, or if a `dymaxion.preferences` exemption covers this
   skill: return `archive_report` with `action_taken: "refused"` and the
   reason — do not proceed
5. If `dry_run: true`: return the full report with
   `action_taken: "dry_run"` and stop
6. Request operator approval via the originating gateway (destructive
   operation, always) — abort cleanly on decline or timeout
7. On approval: move the folder to
   `skills/archived/<skill_slug>-{archive_date}/` via filesystem-mcp,
   deregister the skill from the runtime catalog, write the action to
   `dymaxion.audit_log`
8. Return `archived_path` + `archive_report`

## LLM prompts

### Borderline eligibility classification

System: You classify skill-archive eligibility. Apply the rule exactly:
unused for more than 6 months AND success rate below the library average.
Treat documented seasonal-use patterns as NOT eligible. Answer ELIGIBLE or
NOT_ELIGIBLE on the first line, then one sentence of reasoning citing the
numbers given. Never invent usage data.

User: Skill: {skill_slug}. Last used: {last_used_at}. Success rate:
{success_rate}. Library average: {library_avg_success_rate}. Invocation
count: {invocation_count}. Notes: {usage_notes}.

## Failure modes

- Skill not found under `skills/active/` → fail with the looked-up path;
  nothing to archive
- Operator declines or approval times out → abort with
  `action_taken: "declined"`; no filesystem change, decline recorded in
  `dymaxion.audit_log`
- Folder move fails midway (permissions, partial copy) → roll back to
  `skills/active/`, keep the skill registered, and report the filesystem
  error; never leave the skill half-moved
- Invocation history missing (never-run skill) → treat as ineligible by
  data-insufficiency and report it; absence of data is not evidence of
  staleness

## Cost + timeout

- Max cost per invocation: $0.05
- Max duration: 60 seconds
- Typical actual cost: $0.02, typical duration: 8 seconds
