# Dymaxion — GIS Agent Harness

A long-running, multi-LLM, memory-having, skill-authoring agent for ESRI and
Open Source GIS work. Named for Buckminster Fuller's Dymaxion Map. Framed as
an operator you delegate to, not a chatbot.

- **Framework**: TypeScript + Vercel AI SDK + openid-client; Mastra is retained as development-only compatibility scaffolding in Phase 0
- **Providers**: Anthropic (API key), OpenAI / Google / Azure / Cohere (OAuth 2.0), Ollama (local)
- **Memory**: Postgres 18 + pgvector, Voyage voyage-3-large embeddings
- **Capabilities**: seven implemented native capabilities — the Phase 0 `inspect_dataset` GeoJSON slice, the Phase 1A read-only `inspect_arcgis_org` organization inventory ([docs](docs/capabilities/inspect-arcgis-org.md)), the Phase 1B read-only `trace_arcgis_dependencies` dependency graph ([docs](docs/capabilities/trace-arcgis-dependencies.md)), the Phase 1C read-only `query_feature_service` bounded Feature Service query ([docs](docs/capabilities/query-feature-service.md)), the Phase 1D read-only `validate_spatial_data` bounded local GeoJSON QA report ([docs](docs/capabilities/validate-spatial-data.md)), the Phase 1E read-only `generate_map_artifact` deterministic inline SVG renderer ([docs](docs/capabilities/generate-map-artifact.md)), and the Phase 1F read-only `run_vector_analysis` deterministic local nearest-point analysis between two Point GeoJSON FeatureCollections — plus 45 historical Sprint 1 skill scaffolds; folder presence is not a production-readiness claim, and the remaining roadmap capabilities are not implemented
- **Gateways**: Telegram + CLI + Web (Sprint 1); Teams, Slack, Email, ArcGIS Portal, SMS stubbed
- **Safety**: employer boundary (structural allow/deny lists), human-in-the-loop approvals for destructive ops, per-tier monthly USD budget caps enforced pre-call, append-only audit log, LangFuse tracing

Architecture authority: [ADR-0001](docs/adr/0001-phase-0-runtime-and-execution-boundaries.md) selects the TypeScript/Vercel AI SDK runtime with native middleware and a Mastra-compatible migration path, excludes core LiteLLM, and disables Windows execution pending an allowlisted-job redesign and security testing. Conflicting Sprint 1 statements are historical.

Current verified phase: **Phase 1F deterministic local vector analysis**. The
runtime has seven native read-only capabilities and GISBench has 35 committed
golden tasks (5 each for Phases 0, 1A, 1B, 1C, 1D, 1E, and 1F). Phase 1F is
nearest-point only over bounded local RFC 7946 CRS84 Point FeatureCollections;
it does not use QGIS, ArcPy, live services, basemaps, geocoding, buffering,
overlay, reprojection, topology validation, network access, or artifact writes.

## Install

**macOS / Linux** (single command):

```bash
curl -fsSL https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/install.sh | bash
```

**Windows** (historical Sprint 1 installer; Phase 0 does not enable the native
Windows Worker execution endpoints):

```powershell
irm https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/install.ps1 | iex
```

**Git clone** (any platform, inspect first):

```bash
git clone https://github.com/daraobeirnecode/dymaxion ~/dymaxion
cd ~/dymaxion && ./setup.sh        # .\setup.ps1 on Windows
```

You'll be prompted for five values: Anthropic API key, Telegram bot token,
Telegram chat ID, Voyage API key, and the stable Tailscale login allowed to use
the control plane. Everything else gets strong generated defaults. Typical
time: 10 minutes warm, 25 cold.

## Historical topology reference

The following table describes the Sprint 1 scaffold only. In Phase 0 the Windows
Worker may be built and health-checked, but all ArcPy/ArcGIS Pro execution is
disabled regardless of URL configuration.

| | Runtime | Historical Windows Worker | Worker URL |
| --- | --- | --- | --- |
| **A — Windows-only** | WSL2 + Docker Desktop | disabled native scaffold | not used for execution |
| **B — Split** | Mac Mini (all containers) | disabled remote scaffold | not used for execution |
| **C — Linux/macOS only** | Linux/macOS host | none | unset |

The four arcpy/Pro-dependent skill scaffolds remain unavailable until the
allowlisted-job worker redesign and independent security testing required by
ADR-0001.

## What's running after `docker compose up -d`

| Service | Purpose | Where |
| --- | --- | --- |
| dymaxion-postgres | memory + audit + OAuth tokens (pgvector) | 127.0.0.1:5434 |
| dymaxion-langfuse | LLM observability | http://localhost:3000 (set `LANGFUSE_PORT` in `.env` if 3000 is taken) |
| dymaxion-whisper | voice-memo transcription | internal :8000 |
| dymaxion-runtime | the agent daemon + runtime API | internal :8787 |
| dymaxion-admin | dashboard + web chat + OAuth callbacks | loopback :3001 behind Tailscale Serve |
| dymaxion-skill-sandbox | Docker-in-Docker for proposed skills | internal |

MCP servers (esri, postgres, filesystem, github) run as runtime subprocesses
per `config/mcp-servers.yaml` — not as containers.

Keep `ADMIN_BIND_HOST=127.0.0.1`, set `DYMAXION_ADMIN_IDENTITIES` to the exact
comma-separated Tailscale login(s) allowed to approve, then expose the dashboard
through the authenticating proxy: `tailscale serve --bg localhost:3001`.
Do not bind port 3001 directly to a tailnet IP: approval authentication relies
on Serve stripping spoofed identity headers and injecting `Tailscale-User-Login`.

Every destructive skill also needs an exact trusted identity mapping in
`DYMAXION_CREDENTIAL_IDENTITIES_JSON`, for example
`{"edit_feature_service":"arcgis:prod-org:user-123"}`. This is the account the
runtime will actually use, not a value accepted from an agent plan. Missing
mappings fail closed before an approval is created.

Model-authored skill drafts are stored as review records only. Phase 0 does not
write them into `skills/active`, hot-load them, or accept an “approve” action;
activation remains disabled until a separately reviewed sandbox/promotion design exists.

## Operate

```bash
# talk to it
#   Telegram: message your bot
#   Web:      the HTTPS URL printed by `tailscale serve status` → Chat
docker exec -it dymaxion-runtime dymaxion            # CLI REPL
docker exec -it dymaxion-runtime dymaxion status     # state + recent runs
# batch invocation is limited to trusted non-destructive skills
docker exec -it dymaxion-runtime dymaxion run --skill gdal-format-convert --input '{"input_path":"/workspace/data/x.shp","output_format":"GPKG"}'
docker exec -it dymaxion-runtime dymaxion project switch elk-grove

# scripts
bash scripts/health-check.sh          # containers + external APIs + worker
bash scripts/apply-migrations.sh      # idempotent
bash scripts/register-initial-skills.sh
bash scripts/load-knowledge-base.sh [--refresh]
bash scripts/verify-mcp-servers.sh
bash scripts/verify-windows-worker.sh
bash scripts/replay-run.sh <agent-run-uuid>

# logs / lifecycle
docker compose logs -f dymaxion-runtime
docker compose restart
git pull && docker compose up -d --build   # upgrade
```

`dymaxion run --skill` fails closed for manifests marked `destructive` or
`requires_approval` (and for non-read native capabilities). Run those through
the interactive CLI, Telegram, or Web gateway so the exact bound operation is
presented and its approval is atomically consumed at the shared execution sink.

## Configure

Everything lives in `config/` — no code changes to re-route or re-cap:

| File | Controls |
| --- | --- |
| `llm-providers.yaml` | which providers exist + auth mode |
| `llm-routing.yaml` | skill class → provider:model, fallback chains |
| `llm-budgets.yaml` | monthly USD caps per tier (enforced pre-call; cap hit freezes the tier) |
| `employer-boundary.yaml` | data-source allowlist + hostname/path denylists (no runtime override) |
| `gateways.yaml` | which channels are enabled |
| `mcp-servers.yaml` | MCP subprocess registry |

Connect OAuth providers (OpenAI, Google, Azure, Cohere) in the admin
dashboard → Providers → Connect. Tokens are AES-256-GCM-encrypted in
Postgres and auto-refresh.

## Self-authoring skills

When Dymaxion hits a problem no skill covers, it drafts one (SKILL.md +
manifest + executor), runs a pre-flight lint (no DROP/DELETE/rm -rf/raw
subprocess), saves to `skills/proposed/`, and notifies you. Review and
approve in the dashboard (Skills → Proposed) — approval moves it to
`skills/active/` and hot-reloads the registry. Drafts are capped at $5 LLM
spend and run only in the sandbox until approved.

## Deploy checklist (Sprint 1)

1. Telegram bot created via @BotFather; chat ID known
2. Anthropic API key; Voyage API key
3. Esri portal client credentials (for the Esri MCP), GitHub token (optional)
4. Docker + Tailscale up on the host
5. Run the installer; verify `bash scripts/health-check.sh`
6. Telegram: "list your skills" → catalog reply
7. `tailscale serve status` routes HTTPS to loopback :3001; direct tailnet :3001 is closed
8. Approval test confirms an allowlisted Tailscale identity is recorded as `tailscale:<login>`
9. Windows Worker build/health is historical scaffold verification only; execution remains disabled by ADR-0001

## Repo map

```
config/            YAML configuration (routing, budgets, boundary, gateways, MCP)
migrations/        Postgres schema (dymaxion.*)
dymaxion-runtime/  the agent daemon (TypeScript + AI SDK + middleware chain)
dymaxion-admin/    Next.js 15 dashboard + web chat + OAuth callback routes
docker/whisper/    faster-whisper transcription service
skills/active/     the committed 45-skill historical catalog; runtime promotion is disabled
knowledge-base/    ~115 seed reference docs (stubs in Sprint 1, embedded at load)
windows-worker/    native Windows service for ArcGIS Pro CLI + arcpy
scripts/           operational scripts (migrations, registration, health, replay)
```

QGIS Server / `qgis_process` note: the runtime image ships GDAL + the Python
spatial stack + cli-anything-qgis; full QGIS Server requires extending the
image from ubuntu + ubuntugis-unstable (documented in
`dymaxion-runtime/Dockerfile`). QGIS skills degrade gracefully without it.

See `CLAUDE.md` for iteration conventions after the Sprint 1 scaffold.
