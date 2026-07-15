---
slug: skill-draft
name: Skill Draft
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Skill Draft

## Purpose

The self-authoring skill. Given a failed agent run and a problem description,
draft a brand-new skill — SKILL.md + manifest.yaml + executor stub — and save
it to `skills/proposed/<slug>/` for operator review. Drafted skills are never
activated or executed by this skill; approval and sandbox testing happen
downstream (`skill-test`, admin dashboard).

## When to use this skill

- An agent run failed because no registered skill covers the capability
- The operator explicitly asks Dymaxion to author a new skill
- A recurring manual workaround suggests a missing skill

## When NOT to use this skill

- A similar skill exists and merely underperforms (use `skill-improve`)
- The failure was transient (network, auth, quota) — rerun the original skill
- The capability would violate the employer boundary or prohibited actions;
  refuse rather than draft

## Inputs

- `failed_run_id` (string, required): id of the failing row in
  `dymaxion.agent_runs`
- `problem_description` (string, required): what the user needed that no
  skill could do
- `similar_skill_hints` (array, optional): slugs of skills suspected to be
  near-matches, to seed the similarity search

## Outputs

- `proposed_skill_id` (string): id of the new row in
  `dymaxion.proposed_skills`
- `skill_folder_path` (string): absolute path to the drafted folder under
  `skills/proposed/<slug>/`

## Tools required

- `filesystem-mcp` — read the existing skill library, write the proposed
  skill folder
- `github-mcp` — research reference implementations and upstream tool docs
  during domain research

## Execution plan

Follows the skill authoring flow (E1) from the Skills Library:

1. Read the failing agent-run log for `failed_run_id` from
   `dymaxion.agent_runs`; fail clearly if the run id does not exist
2. Search the skill library for similar patterns — fuzzy match on inputs,
   outputs, and tools, seeded with `similar_skill_hints`
3. If a similar skill exists: recommend forking it instead of drafting from
   scratch, and stop with that recommendation
4. If not: research the domain (github-mcp for reference implementations,
   existing skills for conventions), then draft SKILL.md + manifest.yaml +
   executor stub via the skill_authoring-tier LLM
5. Run pre-flight lint on the drafted executor: reject `DROP`, `DELETE`,
   `rm -rf`, and `subprocess.call` outside the allowlist
6. Save the folder to `skills/proposed/<slug>/` via filesystem-mcp
7. Insert a row into `dymaxion.proposed_skills` (status `pending_review`)
8. Notify the operator via the originating gateway with a review link
9. Return `proposed_skill_id` + `skill_folder_path`; activation only happens
   after operator approval moves the folder to `skills/active/`

## LLM prompts

### Draft the skill

System: You are Dymaxion's skill author. You write complete, minimal skills:
SKILL.md (purpose, when to use / not use, inputs, outputs, tools, execution
plan, failure modes, cost + timeout), manifest.yaml matching the registry
schema, and a Python executor stub that validates inputs and returns
placeholder outputs. Set authored_by: dymaxion-agent. Declare
destructive: true whenever the skill could write to production data — when
unsure, declare it. Never include credentials, live endpoints, or calls
outside the declared tools. Reuse conventions from the provided example
skills exactly.

User: Failed run log: {run_log}. Problem: {problem_description}.
Nearest existing skills (for convention reference, none matched closely):
{similar_skills_summary}. Draft the full skill folder contents for a new
skill that would have handled this run. Propose a slug.

### Similarity verdict

System: You compare a needed capability against existing skill specs. Answer
with FORK <slug> if an existing skill covers >= 70 percent of the need, else
NEW. One line, then a two-sentence justification.

User: Need: {problem_description}. Candidates: {candidate_skill_specs}.

## Failure modes

- `failed_run_id` not found in `dymaxion.agent_runs` → fail immediately with
  the id echoed back; do not draft from the description alone
- Pre-flight lint rejects the drafted executor → regenerate once with the
  lint findings appended to the prompt; if it fails again, save nothing and
  report the lint output
- Similarity search finds a near-match → stop and recommend
  `skill-improve`/fork with the matched slug; drafting a duplicate is a
  failure, not a success
- Cost cap ($5.00) reached mid-draft → save nothing, report partial progress
  and where the budget went

## Cost + timeout

- Max cost per invocation: $5.00 (self-authoring hard cap)
- Max duration: 300 seconds
- Typical actual cost: $0.80, typical duration: 120 seconds
