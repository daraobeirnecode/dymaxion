---
slug: deployment-topology-decide
name: Deployment Topology Decide
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Deployment Topology Decide

## Purpose

Given a workload description (client count, data volume, real-time requirements,
budget), recommend a deployment topology for a GIS stack: single VM, Docker
Compose, Kubernetes, or serverless. Returns an architecture doc framed as
"recommend, with tradeoffs" — never a claim of certainty.

## When to use this skill

- User asks "how should I deploy this?" or "VM vs Kubernetes?" for a GIS workload
- User describes a new project and needs a hosting/orchestration recommendation
- An existing deployment is straining and the user wants a re-evaluation

## When NOT to use this skill

- User has already committed to a topology and needs implementation help
  (use the relevant scaffold/publish skills instead)
- Question is about a single component's tile serving (use `tile-server-decide`)
- Question is about database selection (use `database-choice-decide`)

## Inputs

- `workload_description` (string, required): free-text description of the
  workload — apps, users, data flows, real-time needs
- `client_count` (number, optional): expected concurrent or total clients
- `data_volume_gb` (number, optional): approximate total data volume in GB
- `realtime_required` (boolean, optional): whether sub-second/live updates matter
- `budget_constraint` (string, optional): e.g. "under $200/month hosting"

## Outputs

- `architecture_doc` (string): Markdown architecture document with a primary
  recommendation, at least two alternatives, and explicit tradeoffs for each
- `recommended_topology` (string): one of `single-vm`, `docker-compose`,
  `kubernetes`, `serverless`
- `tradeoffs` (array): structured list of tradeoff entries
  (`{option, pros, cons, cost_note}`)

## Tools required

- None. Pure reasoning skill — no MCP or CLI tools.

## Execution plan

1. Validate `workload_description` is present and non-trivial (> 20 chars);
   fail with a clear error otherwise
2. Normalize inputs: derive load tier (light / moderate / heavy) from
   `client_count` + `data_volume_gb` + `realtime_required`
3. Enumerate the four candidate topologies and score each against workload,
   ops burden, budget, and growth headroom
4. Call the reasoning-tier LLM with the system prompt below to draft the
   architecture doc: recommendation, two alternatives, tradeoffs, cost ballpark
5. Extract `recommended_topology` and structured `tradeoffs` from the draft
6. Return the doc + structured fields; log run to `dymaxion.skill_invocations`

## LLM prompts

### Draft architecture recommendation

System: You are a GIS deployment architect. You recommend, with tradeoffs —
you never claim certainty. Every recommendation names at least two viable
alternatives and states concretely when each alternative would be the better
choice. Use concrete numbers where the inputs provide them. Cite the input
assumptions you relied on. If inputs are missing, state the assumption you
made instead. No marketing language, no emoji.

User: Workload: {workload_description}. Clients: {client_count}.
Data volume: {data_volume_gb} GB. Real-time: {realtime_required}.
Budget: {budget_constraint}. Candidates: single VM, Docker Compose,
Kubernetes, serverless. Produce a Markdown architecture doc with sections:
Recommendation, Why, Alternatives (with when-to-prefer), Tradeoffs table,
Estimated monthly cost, Assumptions.

## Failure modes

- `workload_description` missing or too vague to score → fail fast with an
  error asking for client count, data volume, and real-time needs
- LLM response missing a parseable topology recommendation → retry once with a
  stricter instruction to end with `RECOMMENDED: <topology>`; if still
  unparseable, return the doc with `recommended_topology: "undetermined"`
- Budget cap hit mid-draft → return partial doc with a `truncated: true` note
  rather than silently dropping sections

## Cost + timeout

- Max cost per invocation: $0.80
- Max duration: 180 seconds
- Typical actual cost: $0.40, typical duration: 45 seconds
