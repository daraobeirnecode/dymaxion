# Dymaxion — CLAUDE.md

## Project purpose

Long-running GIS agent for ESRI + Open Source GIS work. Multi-LLM, persistent memory, real skills, self-authoring, multi-gateway. Runs on the Mac Mini (or Hetzner AI OS) alongside your existing Hermes stack.

Named for Gerardus Dymaxion. Framed as an operator you delegate to, not a chatbot.

## Stack (containers) — UPDATED 2026-07-14

Framework: **TypeScript/Node.js runtime** + **Vercel AI SDK** for LLM providers + **openid-client** for OAuth. Mastra is development-only compatibility scaffolding and is absent from the production dependency tree. NOT using LiteLLM in the core runtime. [ADR-0001](docs/adr/0001-phase-0-runtime-and-execution-boundaries.md) is authoritative; conflicting Sprint 1 architecture text is historical.

- **dymaxion-runtime** — TypeScript/Node.js 22+ agent daemon (native middleware; Mastra dev-only scaffolding per ADR-0001)
- **dymaxion-postgres** — Postgres 18 + pgvector + AGE (memory + audit + OAuth tokens)
- **dymaxion-langfuse** — LLM observability (self-hosted)
- **dymaxion-whisper** — voice-memo transcription (faster-whisper)
- **dymaxion-admin** — Next.js 15 dashboard (Tailscale-only) with OAuth callback routes
- **dymaxion-skill-sandbox** — Docker-in-Docker for proposed skills

MCP servers (esri, postgres, filesystem, github) are runtime SUBPROCESSES
spawned per `config/mcp-servers.yaml` — not containers.

Plus (historical scaffold only):
- **windows-worker** — optional Node.js service code for ArcGIS Pro CLI + arcpy. Phase 0 execution is disabled pending an allowlisted-job redesign and independent security testing.

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

- **Versioned capabilities, not prompt-only behavior.** Production capability behavior has strict schemas, classification, limits, validation and evidence. The 45 Sprint 1 skill folders are historical scaffolds unless independently implemented and tested; native capabilities may use the runtime dispatcher without adding catalog folders.
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

## Implemented native capabilities

Exactly eight native capabilities are implemented and tested; everything else
in the catalog is historical scaffold (see ADR-0001 and the README):

- **`inspect_dataset`** (Phase 0) — deterministic, read-only local GeoJSON
  inspection producing a dataset passport plus versioned evidence.
- **`inspect_arcgis_org`** (Phase 1A) — deterministic, read-only ArcGIS
  Online/Enterprise organization inventory over the Portal REST API
  (users/groups/items/service-backed items with ownership, sharing, and
  staleness summaries). Docs: `docs/capabilities/inspect-arcgis-org.md`.
- **`trace_arcgis_dependencies`** (Phase 1B) — deterministic, read-only
  downstream dependency graph from approved portal items (Web Mapping
  Application → Web Map → item/service references over explicitly supported
  JSON paths only), with cycles, unresolved references, impact summaries,
  sanitized never-dispatched service leaves, and honest truncation.
  Docs: `docs/capabilities/trace-arcgis-dependencies.md`.
- **`query_feature_service`** (Phase 1C) — deterministic, read-only
  attribute (and optional geometry) query against one approved
  anonymous/public HTTPS `FeatureServer/<layer-id>` URL: metadata and
  query-capability validation first, explicit metadata-validated fields with
  automatic object-ID inclusion, canonical object-ID discovery and batch
  paging over POST forms, bounded deterministic `exceededTransferLimit`
  splitting, strict response identity/completeness checks, honest
  truncation, and evidence with canonical request-body hashes (no query
  values in URLs). Statistics, ordering, geometry filters, transformations,
  attachments, and related records are rejected in this slice.
  Docs: `docs/capabilities/query-feature-service.md`.
- **`validate_spatial_data`** (Phase 1D) — deterministic, read-only bounded
  spatial QA of one allowlisted local RFC 7946 GeoJSON FeatureCollection:
  strict structure, typed canonical feature IDs, null/empty geometries,
  position shape/dimension/CRS84-range checks, line/ring cardinality, exact
  ring closure, consecutive duplicate vertices, zero-area rings, a bounded 2D
  ring self-intersection check, per-position bbox enclosure (including
  antimeridian-crossing CRS84 bboxes), and stable property-null profiles,
  with deterministic bounded top-K finding retention, explicit
  `checks_not_run` honesty (never a full OGC/GEOS validity claim), and hard
  byte/feature/coordinate/depth/duration/cancellation ceilings.
  Docs: `docs/capabilities/validate-spatial-data.md`.
- **`generate_map_artifact`** (Phase 1E) — deterministic, read-only rendering
  of one allowlisted local RFC 7946 GeoJSON FeatureCollection into a bounded,
  self-contained inline UTF-8 SVG. It supports all GeoJSON geometry families,
  multipart polygons and holes; uses a minimal circular longitude interval for
  antimeridian fitting; returns exact SVG byte/hash evidence, structured
  source/extent/viewport/style/legend/QA metadata; and writes no file. It has
  no basemap, labels, scale claim, projection transform, classification,
  statistics, network access or publication path. Docs:
  `docs/capabilities/generate-map-artifact.md`.
- **`run_vector_analysis`** (Phase 1F) — deterministic, read-only nearest-point
  analysis between two allowlisted local RFC 7946 CRS84 Point FeatureCollections.
  It returns an inline canonical GeoJSON artifact plus report/evidence, uses
  spherical Haversine distance with authalic radius `6,371,008.8` meters,
  rounds to the nearest millimetre, resolves ties by candidate source index,
  supports optional `max_distance_meters`, and writes/fetches nothing. It is
  Point-only and nearest-point-only: no reprojection, topology validation,
  spatial index, buffering, overlay, routing, geocoding, QGIS, ArcPy, or live
  service analysis.
- **`export_evidence_bundle`** (Phase 1G) — deterministic packaging of one
  bounded report, one upstream EvidenceBundle and one inline artifact into an
  exact four-entry ZIP32 STORE archive. `preview` is mutation-free; `persist`
  requires approval bound to the full input and exact project/archive target,
  then performs project-scoped create-only publication under a trusted internal
  root with read-back verification. Approval facts remain authoritative in the
  approval subsystem/audit record and are not serialized into the response or ZIP. Docs:
  `docs/capabilities/export-evidence-bundle.md`.

Phase 1A/1B/1C/1D/1E/1F/1G constraints that still hold:

- **Fixture-only testing.** All `inspect_arcgis_org`,
  `trace_arcgis_dependencies`, and `query_feature_service` tests and
  GISBench tasks run against committed synthetic fixtures through an
  injectable transport with stubbed DNS. No
  authenticated or private ArcGIS organization was queried during
  development, and none may be queried in tests.
- **No trusted ArcGIS credential provider exists yet.** The capability runs
  with anonymous/public visibility only, never accepts credential-like input
  fields, and reports always carry a partial-visibility caveat. Any future
  authentication must be a trusted server-side provider — credential values
  never appear in inputs, outputs, evidence, or logs.
- **Enterprise custom hosts need explicit boundary configuration.** The
  employer boundary allowlists `*.arcgis.com` / `*.maps.arcgis.com`; a
  customer ArcGIS Enterprise portal on its own domain must be added by hand
  to `config/employer-boundary.yaml` before it can be inspected. Deny rules
  (City of Sacramento hosts) always win.
- **Dependency tracing never dispatches item-provided URLs.** Outbound
  `trace_arcgis_dependencies` requests are constructed only from the
  validated portal root plus validated 32-hex item IDs; service URLs found in
  item data are sanitized terminal graph references only.
- **Feature queries never dispatch remote-returned URLs or leak query
  values.** `query_feature_service` requests only the validated layer URL
  and `<layer_url>/query`; query predicates, object IDs, and field lists
  travel in POST form bodies that are hashed into evidence but never
  serialized, and evidence URLs for query dispatches carry no query string.
- **Spatial validation never touches the network.** `validate_spatial_data`
  reads exactly one allowlisted local `.geojson` file through the shared
  boundary; it accepts no URLs, dispatches no requests, echoes no raw
  untrusted values (feature IDs, geometry types, coordinates, property
  values, unrecognized legacy CRS names, unsafe property field names) into
  findings, errors, or evidence, keeps filesystem mtime out of its evidence
  for same-byte determinism, and never claims full OGC/GEOS validity.
- **Map artifact generation never writes or fetches.**
  `generate_map_artifact` reads exactly one allowlisted raw-path `.geojson`
  source, never renders source properties, and returns only static inline SVG
  plus report/evidence. It rejects every percent escape and remote URI before
  boundary/recorder/I/O, reasserts the boundary before both filesystem sinks,
  and never claims a scale, basemap, labels or analysis.
- **Vector analysis is local nearest-point only.** `run_vector_analysis` reads
  exactly two distinct allowlisted raw-path `.geojson` Point FeatureCollections,
  returns one inline derived GeoJSON artifact plus report/evidence, omits
  candidate properties, and rejects percent escapes, remote URI syntax,
  credential-shaped path text, reserved `_dymaxion` primary properties, legacy
  `crs`, non-Point geometries and paths outside the workspace boundary. Do not
  expand beyond `nearest_point` without a new plan and review.
- **Evidence export is bounded and internal only.** `export_evidence_bundle`
  reads no caller path and dispatches no request. It accepts one inline derived
  artifact, never raw source data; preview never mutates; persist uses a trusted
  configured root, exact-hash approval, a one-execution grant, create-only
  publication, quota enforcement and read-back verification. No remote upload,
  GIS publication, signing, encryption, update/delete or download endpoint.
- **GISBench has exactly forty golden tasks** — five each for Phase 0
  `inspect_dataset`, Phase 1A `inspect_arcgis_org`, Phase 1B
  `trace_arcgis_dependencies`, Phase 1C `query_feature_service`, Phase 1D
  `validate_spatial_data`, Phase 1E `generate_map_artifact`, Phase 1F
  `run_vector_analysis`, and Phase 1G `export_evidence_bundle` — an evaluation
  scaffold toward the 100-task goal, not a coverage claim.

## Build + verify

- Runtime checks: `cd dymaxion-runtime && npm run typecheck && npm test`
- GISBench: `cd dymaxion-runtime && npm run gisbench`
- Runtime: `cd dymaxion-runtime && npm run build` (tsc strict) then `DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test`
- Admin: `cd dymaxion-admin && npm run build`
- Worker: `cd windows-worker && npm run build`
- Stack: `docker compose config -q`; migrations are idempotent (`scripts/apply-migrations.sh`)

## Current task: Phase 1G deterministic evidence export

Implement `docs/plans/2026-07-21-phase-1g-export-evidence-bundle.md` as one
bounded vertical slice.

- New native capability: `export_evidence_bundle`.
- Package one report, one upstream EvidenceBundle and one inline artifact into
  exactly four deterministic ZIP32 STORE members.
- Keep `preview` mutation-free; require full-input/exact-target approval for
  `persist`, with a one-execution grant revalidated at storage sinks.
- Publish create-only under a trusted internal project-scoped root with strict
  symlink/race/quota/read-back checks; never accept the root from caller input.
- Add five synthetic GISBench tasks, raising the suite from 35 to 40, plus
  focused adversarial tests and exact integrity validation before normalization.
- Preserve all earlier approval, identity, boundary, determinism, evidence,
  redaction and Worker invariants.
- Do not access live GIS systems, add credentials, upload/publish remotely,
  sign/encrypt, export raw sources, deploy or merge without exact-SHA review.
