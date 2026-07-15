# Dymaxion — CLAUDE.md

## Project purpose

Long-running GIS agent for ESRI + Open Source GIS work. Multi-LLM, persistent memory, real skills, self-authoring, multi-gateway. Runs on the Mac Mini (or Hetzner AI OS) alongside your existing Hermes stack.

Named for Gerardus Dymaxion. Framed as an operator you delegate to, not a chatbot.

## Stack (containers) — UPDATED 2026-07-14

Framework: **Mastra** (TypeScript agent framework) + **Vercel AI SDK** for LLM providers + **openid-client** for OAuth. NOT using LiteLLM (removed in favor of native TypeScript middleware). See `Framework Decision.md` for reasoning.

- **dymaxion-runtime** — TypeScript/Node.js 20+ agent daemon on Mastra
- **dymaxion-postgres** — Postgres 18 + pgvector + AGE (memory + audit + OAuth tokens)
- **dymaxion-langfuse** — LLM observability (self-hosted)
- **dymaxion-whisper** — voice-memo transcription (faster-whisper)
- **dymaxion-admin** — Next.js 15 dashboard (Tailscale-only) with OAuth callback routes
- **dymaxion-skill-sandbox** — Docker-in-Docker for proposed skills

MCP servers (esri, postgres, filesystem, github) are runtime SUBPROCESSES
spawned per `config/mcp-servers.yaml` — not containers.

Plus:
- **windows-worker** — Node.js service on the Windows machine for ArcGIS Pro CLI + arcpy (Sprint 1 first-class; Tailscale-connected on split topology, host.docker.internal on Windows-only topology)

Multi-arch: all container images built for linux/amd64 + linux/arm64 — runs natively on Apple Silicon and x86_64 Linux.

LLM providers + auth mode:
- **Anthropic** — API key (per requirement)
- **OpenAI** — OAuth 2.0
- **Google Gemini** — OAuth 2.0
- **Azure OpenAI** — OAuth 2.0 (Entra ID)
- **Cohere** — OAuth 2.0
- **Ollama** (local) — no auth
- All routed through the 6-step middleware chain in `src/llm/middleware.ts`

Install:
- `curl -fsSL https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/install.sh | bash`
- OR `git clone && ./setup.sh`
- Cross-platform: macOS (Homebrew for prereqs) + Linux

## Design non-negotiables

- **Skills, not conversation.** Every capability is a real skill folder with SKILL.md + manifest.yaml + executor. No capability lives only in prompts.
- **Human-in-the-loop for consequences.** All destructive operations (write to production, drop table, publish service, delete file) require explicit approval via the originating gateway.
- **Multi-LLM.** Every LLM call goes through the 6-step middleware chain in `src/llm/middleware.ts`. Provider is configurable per skill via `config/llm-routing.yaml`. No provider is hardcoded.
- **Persistent memory.** Postgres schema `dymaxion.*` holds messages, projects, preferences, skill history, audit log. Never re-explain.
- **Cost caps everywhere.** Per-tier virtual budget (config/llm-budgets.yaml, ledger in `dymaxion.budget_ledger`) with monthly USD cap, enforced pre-call. Runaway blocks itself.
- **Employer boundary — structural.** Allowlist of data sources + denylist of hostnames enforced at the skill-executor level. Config lives in `config/employer-boundary.yaml`.
- **Explainability.** Every action logged in Postgres + LangFuse. Every response includes narrative explanation. Every run is replayable.

## Voice rules (Dymaxion's responses)

- Operator tone — reports what it did, what it found, what it recommends. Not chatty.
- Uses concrete numbers ("47 features matched" not "several features")
- Cites data sources ("from `parcels_2026` Feature Service, updated 2026-07-12")
- Reports cost + duration at end of each run ("Ran in 43s, cost $0.18")
- Warns before destructive operations, always
- Never claims certainty on architecture recommendations — always frames as "recommend, with tradeoffs"
- No emoji

## Prohibited (for the agent)

- Never touch City of Sacramento data or systems
- Never invoke a proposed skill outside the sandbox
- Never bypass an approval request
- Never issue an LLM call that skips the middleware chain (`src/llm/middleware.ts`)
- Never store credentials outside SOPS-encrypted `.env` files
- Never overwrite user files without an approval request
- Never publish to production ArcGIS org without approval

## Prohibited (for developers iterating post-Fable-5)

- Never add a skill without SKILL.md + manifest.yaml + tests
- Never hardcode an LLM provider — always route through `config/llm-routing.yaml` + the middleware chain
- Never add a gateway that requires public webhook without documenting the Cloudflare Tunnel setup
- Never add a skill that writes to `dymaxion.*` schema outside of the skill's declared write scope
- Never bypass the manifest's `destructive: true` flag

## Skill authoring rules

- Every skill has `slug`, `name`, `version` (semver), `skill_class`, `authored_by`, `approved_at`
- `destructive: true` → registered as requiring approval; runtime enforces
- `requires_approval: true` → runtime asks the operator before invoking
- `budget.max_cost_usd` and `budget.max_duration_seconds` are hard limits — enforced
- `tools` list must reference registered tools/MCPs; validated at registration
- `authored_by: dymaxion-agent` → skill was self-authored; requires manual review before first use

## Memory conventions

- `dymaxion.messages` — every incoming/outgoing message, embedded, timestamped
- `dymaxion.projects` — one row per engagement/project; `context: JSONB` holds portal URLs, CRSs, key datasets
- `dymaxion.datasets` — named datasets with source URI + schema
- `dymaxion.preferences` — user-level preferences (single-row-per-key)
- `dymaxion.agent_runs` — one row per request handled
- `dymaxion.skill_invocations` — many per agent_run, one per skill call
- `dymaxion.audit_log` — append-only event log (llm_call, tool_call, boundary_block, approval, ...); never deleted
- `dymaxion.skill_registry` / `dymaxion.skill_history` — catalog + aggregate outcome stats
- `dymaxion.proposed_skills` / `dymaxion.approval_requests` — human-in-the-loop queues
- `dymaxion.oauth_tokens` — encrypted provider tokens (AES-256-GCM; never logged)
- `dymaxion.budget_ledger` — monthly per-tier spend; frozen on cap hit

## Build + verify

- Runtime: `cd dymaxion-runtime && npm run build` (tsc strict) then `DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test`
- Admin: `cd dymaxion-admin && npm run build`
- Worker: `cd windows-worker && npm run build`
- Stack: `docker compose config -q`; migrations are idempotent (`scripts/apply-migrations.sh`)