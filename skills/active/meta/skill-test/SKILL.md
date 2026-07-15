---
slug: skill-test
name: Skill Test
version: 0.1.0
skill_class: none
authored_by: dymaxion-core-library
---

# Skill Test

## Purpose

Execute a proposed skill inside the Docker sandbox (`dymaxion-skill-sandbox`)
against its test fixtures and report pass/fail plus captured logs. Pure
execution — no LLM involved. Never touches production data: the sandbox has
no network route to production systems and mounts the skill folder read-only.

## When to use this skill

- A skill drafted by `skill-draft` awaits validation before operator approval
- The operator asks to re-verify a proposed skill after edits
- A revised executor from `skill-improve` needs a sandbox check before the
  diff is approved

## When NOT to use this skill

- Skill is already active — invoke it directly; this skill only runs
  `skills/proposed/`
- No fixtures exist yet — write `tests/fixtures/sample-input.json` and
  `tests/expected-output.json` first
- The check needed is a review of skill design/prose, not execution
  (that is operator review, not this skill)

## Inputs

- `proposed_skill_slug` (string, required): slug under `skills/proposed/`
- `fixture_path` (string, optional): fixture to feed the executor; default
  `tests/fixtures/sample-input.json` inside the skill folder
- `timeout_seconds` (number, optional): per-run sandbox timeout; default 60,
  hard-capped by this skill's own 300s budget

## Outputs

- `test_result` (object): `{passed, exit_code, output_matches_expected,
  duration_seconds}`
- `sandbox_logs` (string): combined stdout/stderr captured from the sandbox
  container

## Tools required

- `docker` (via `dymaxion-skill-sandbox`) — isolated Docker-in-Docker
  execution environment

## Execution plan

1. Verify `skills/proposed/<proposed_skill_slug>/` exists and contains
   SKILL.md, manifest.yaml, executor.py; fail listing whatever is missing
2. Parse manifest.yaml; validate against the registry schema (same validation
   as startup registration)
3. Resolve the fixture: `fixture_path` if given, else the default; fail if
   absent
4. Launch the sandbox container with the skill folder mounted read-only, no
   production network, scratch `/workspace` only
5. Pipe the fixture JSON to the executor's stdin; capture stdout, stderr,
   exit code; enforce `timeout_seconds`
6. Compare stdout against `tests/expected-output.json` when present
   (JSON-equality, not byte-equality)
7. Assemble `test_result` + `sandbox_logs`, write outcome to
   `dymaxion.skill_invocations`, and return

## LLM prompts

None. This skill is execution-only (`skill_class: none`); it issues no LLM
calls and incurs no LLM cost.

## Failure modes

- Proposed skill folder or fixture missing → fail immediately with the exact
  missing path; nothing is executed
- Executor exceeds `timeout_seconds` → kill the container, report
  `passed: false` with `exit_code: -1` and partial logs
- Sandbox container fails to start (docker daemon down, image missing) →
  report an infrastructure error distinctly from a test failure so the
  proposed skill is not wrongly marked failing
- Executor output is not valid JSON → `passed: false` with the raw stdout in
  `sandbox_logs` for diagnosis

## Cost + timeout

- Max cost per invocation: $0.05 (container compute only; no LLM spend)
- Max duration: 300 seconds
- Typical actual cost: $0.00, typical duration: 15 seconds
