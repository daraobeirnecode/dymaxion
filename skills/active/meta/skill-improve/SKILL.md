---
slug: skill-improve
name: Skill Improve
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Skill Improve

## Purpose

Given an existing skill and a failure log, propose an updated version of the
skill in diff mode. Nothing is applied — the proposed diff is presented to
the operator for approval, and only an approved diff is written back by the
runtime.

## When to use this skill

- An active skill failed and the log points at a fixable defect (missing
  retry, bad prompt, wrong default, unhandled edge case)
- A skill's success rate is trending down in `dymaxion.skill_invocations`
- The operator asks for a specific enhancement to an existing skill

## When NOT to use this skill

- No comparable skill exists at all (use `skill-draft`)
- The failure was environmental (network outage, expired credentials) —
  nothing in the skill needs to change
- The change would alter the skill's `destructive` flag or write scope —
  that requires manual authoring and review, not an automated diff

## Inputs

- `skill_slug` (string, required): slug of the existing skill under
  `skills/active/`
- `failure_log` (string, required): failure text — executor stderr, agent-run
  error, or an operator-written defect description
- `improvement_hint` (string, optional): operator steer, e.g. "add
  exponential backoff and a mirror fallback"

## Outputs

- `proposed_diff` (string): unified diff across SKILL.md, manifest.yaml,
  and/or executor.py
- `change_summary` (string): plain-language summary of what changes, why it
  addresses the failure, and any behavior/cost impact

## Tools required

- `filesystem-mcp` — read the current skill folder; the diff itself is
  returned, not applied

## Execution plan

1. Verify `skills/active/<skill_slug>/` exists; fail with the exact path
   otherwise
2. Read SKILL.md, manifest.yaml, executor.py via filesystem-mcp
3. Pull the skill's recent invocation history from
   `dymaxion.skill_invocations` for failure-pattern context
4. Call the workhorse-tier LLM with the system prompt below to produce
   revised file contents targeting the failure
5. Compute a unified diff (current → proposed) per changed file; bump
   `version` patch level in both manifest and SKILL.md frontmatter as part of
   the diff
6. Sanity-check the diff: must not touch `destructive`, `requires_approval`,
   or widen `tools`/write scopes; reject and retry once if it does
7. Return `proposed_diff` + `change_summary`; runtime routes it to the
   operator for approval before anything is applied

## LLM prompts

### Propose the improvement

System: You maintain Dymaxion skills. You change the minimum needed to fix
the reported failure — no rewrites, no style churn, no scope creep. Preserve
the manifest schema, the skill's declared tools, and its destructive and
approval flags exactly. If the correct fix requires widening scope or
changing flags, say so in prose and make no change to those lines. Output the
complete revised content of each file you change, and nothing for files you
do not.

User: Skill: {skill_slug} version {current_version}. Current files:
{skill_files}. Failure log: {failure_log}. Recent invocation stats:
{invocation_stats}. Operator hint: {improvement_hint}. Propose the fix.

## Failure modes

- `skill_slug` not found under `skills/active/` → fail with the looked-up
  path; suggest `skill-draft` if the operator meant a new capability
- Proposed change touches `destructive`/`requires_approval`/`tools` → reject
  the draft, retry once with a stronger constraint; if it recurs, return an
  explanation instead of a diff
- Failure log too thin to diagnose → return a `change_summary` requesting
  specific missing evidence (stderr, input params) rather than a speculative
  diff
- Diff fails to apply cleanly in a dry run → regenerate once against the
  freshly re-read files; then fail with both versions attached

## Cost + timeout

- Max cost per invocation: $0.50
- Max duration: 180 seconds
- Typical actual cost: $0.25, typical duration: 40 seconds
