# Dymaxion — GIS Agent Harness

A long-running, multi-LLM, memory-having, skill-authoring agent for ESRI and
Open Source GIS work. Named for Buckminster Fuller's Dymaxion Map. Framed as
an operator you delegate to, not a chatbot.

- **Framework**: Mastra (TypeScript) + Vercel AI SDK + openid-client
- **Providers**: Anthropic (API key), OpenAI / Google / Azure / Cohere (OAuth 2.0), Ollama (local)
- **Memory**: Postgres 18 + pgvector, Voyage voyage-3-large embeddings
- **Capabilities**: 45 historical Sprint 1 skill scaffolds plus the Phase 0 native `inspect_dataset` vertical slice; folder presence is not a production-readiness claim
- **Gateways**: Telegram + CLI + Web (Sprint 1); Teams, Slack, Email, ArcGIS Portal, SMS stubbed
- **Safety**: employer boundary (structural allow/deny lists), human-in-the-loop approvals for destructive ops, per-tier monthly USD budget caps enforced pre-call, append-only audit log, LangFuse tracing

Architecture authority: [ADR-0001](docs/adr/0001-phase-0-runtime-and-execution-boundaries.md) selects the TypeScript/Mastra/Vercel AI SDK runtime with native middleware, excludes core LiteLLM, and disables Windows execution pending an allowlisted-job redesign and security testing. Conflicting Sprint 1 statements are historical.

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

You'll be prompted for four values: Anthropic API key, Telegram bot token,
Telegram chat ID, Voyage API key. Everything else gets strong generated
defaults. Typical time: 10 minutes warm, 25 cold.

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
| dymaxion-admin | dashboard + web chat + OAuth callbacks | http://$ADMIN_BIND_HOST:3001 |
| dymaxion-skill-sandbox | Docker-in-Docker for proposed skills | internal |

MCP servers (esri, postgres, filesystem, github) run as runtime subprocesses
per `config/mcp-servers.yaml` — not as containers.

Set `ADMIN_BIND_HOST` in `.env` to your Tailscale IP (e.g. `100.117.65.43`) so
the dashboard is reachable only inside your tailnet. The installer does this
automatically when Tailscale is detected.

## Operate

```bash
# talk to it
#   Telegram: message your bot
#   Web:      http://$ADMIN_BIND_HOST:3001 → Chat
docker exec -it dymaxion-runtime dymaxion            # CLI REPL
docker exec -it dymaxion-runtime dymaxion status     # state + recent runs
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
7. Admin dashboard reachable on :3001, LangFuse on :3000
8. Windows Worker build/health is historical scaffold verification only; execution remains disabled by ADR-0001

## Repo map

```
config/            YAML configuration (routing, budgets, boundary, gateways, MCP)
migrations/        Postgres schema (dymaxion.*)
dymaxion-runtime/  the agent daemon (Mastra + AI SDK + middleware chain)
dymaxion-admin/    Next.js 15 dashboard + web chat + OAuth callback routes
docker/whisper/    faster-whisper transcription service
skills/active/     the 45-skill catalog (proposed/ + archived/ created at runtime)
knowledge-base/    ~115 seed reference docs (stubs in Sprint 1, embedded at load)
windows-worker/    native Windows service for ArcGIS Pro CLI + arcpy
scripts/           operational scripts (migrations, registration, health, replay)
```

QGIS Server / `qgis_process` note: the runtime image ships GDAL + the Python
spatial stack + cli-anything-qgis; full QGIS Server requires extending the
image from ubuntu + ubuntugis-unstable (documented in
`dymaxion-runtime/Dockerfile`). QGIS skills degrade gracefully without it.

See `CLAUDE.md` for iteration conventions after the Sprint 1 scaffold.
