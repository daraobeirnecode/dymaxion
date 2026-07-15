---
slug: field-mapping-app
name: Field Mapping App Scaffold
version: 0.1.0
skill_class: reasoning
authored_by: dymaxion-core-library
---

# Field Mapping App Scaffold

## Purpose

Scaffold an Expo offline-first field-mapping app: local SQLite spatial storage
(expo-sqlite + SpatiaLite-style geometry columns), a capture workflow (GPS
point + attribute form + camera photos), and a sync engine that pushes local
edits to PostGIS on reconnect and pulls server changes. Architecture-heavy —
the sync-conflict strategy is reasoned per project, not templated.

## When to use this skill

- User needs field data **capture**, not just field map viewing: inspections,
  asset inventory, damage assessment
- Requirements include working with no connectivity for hours/days and syncing
  later
- The back office is PostGIS (directly or behind an API)

## When NOT to use this skill

- View-only offline maps → `expo-map-scaffold` is a fraction of the cost and
  complexity
- Back office is ArcGIS Enterprise/Online → ArcGIS Field Maps or the ArcGIS
  Maps SDK for Kotlin/Swift offline workflow is the right tool; recommend it
  instead of building
- Single-day, connected data collection → a simple web form + PWA is enough

## Inputs

- `project_name` (string, required): Expo app slug
- `output_dir` (string, required): parent directory for the project
- `feature_schema` (object, required): capture schema —
  `{ layer_name, geometry_type, fields: [{ name, type, required, domain? }] }`
- `sync_target` (object, required): `{ api_base_url, table, id_field }` — the
  PostGIS-backed sync endpoint (direct DB connections from devices are refused)
- `conflict_policy` (string, optional): `server-wins | client-wins |
  last-write-wins | manual-queue`. Default `last-write-wins`, but see LLM step —
  the skill recommends and explains a policy for the schema before applying it
- `enable_camera` (boolean, optional, default true): photo attachments per feature
- `enable_gps_tracks` (boolean, optional, default false): background track
  recording in addition to point capture
- `style_url` (string, optional): basemap style for the map screen

## Outputs

- `project_path` (string): absolute path to the scaffolded project
- `files_created` (array): relative paths written
- `architecture_notes` (string): the reasoning record — chosen sync/conflict
  design, schema mapping, and the tradeoffs considered
- `sync_endpoint_spec` (object): OpenAPI-style spec the server side must
  implement (push, pull, ack endpoints)
- `next_steps` (array): server endpoint implementation, device build, pilot plan

## Tools required

- `filesystem-mcp` — write project files
- `npm` — create-expo-app, dependency install, `tsc --noEmit`

## Execution plan

1. Validate `feature_schema` (geometry type in point/line/polygon; field types
   in text/integer/real/date/photo; domains are value lists) and `sync_target`
   shape; refuse direct `postgres://` URLs in `api_base_url` — devices must
   sync via API, per employer-boundary and credential rules
2. Reason about the sync design (LLM step 1): given schema, expected edit
   volume, and `conflict_policy`, produce the conflict-resolution plan, the
   local change-log table design, and the endpoint spec; this becomes
   `architecture_notes` + `sync_endpoint_spec`
3. Scaffold Expo TypeScript app; install `@maplibre/maplibre-react-native`,
   `expo-sqlite`, `expo-location`, `expo-camera`, `expo-task-manager` (tracks),
   `@react-native-community/netinfo`
4. Generate the local store: SQLite DDL for the feature table (geometry as
   GeoJSON text + spatial index columns), `change_log` table (op, feature_id,
   payload, synced_at), and typed data-access module
5. Generate capture UX: map screen with "capture at GPS fix" flow, attribute
   form generated from `feature_schema` (required fields enforced, domains as
   pickers), photo attach if enabled
6. Generate the sync engine (LLM step 2): NetInfo-triggered push of unsynced
   change-log entries, pull of server deltas since last cursor, conflict
   handling per the chosen policy, exponential backoff
7. Run `npx tsc --noEmit`; one repair pass on failure
8. Return outputs, including full `architecture_notes`

## LLM prompts

### 1. Sync architecture design

System: You are a senior offline-sync architect for field GIS. Be explicit
about failure windows (edit during sync, duplicate capture, clock skew). Always
present the chosen design as a recommendation with tradeoffs, never as the only
correct answer. Output JSON with keys: conflict_design, change_log_schema,
endpoint_spec, tradeoffs.

User: Feature schema: {feature_schema_json}. Requested conflict policy:
{conflict_policy}. Expected pattern: multiple field devices, hours offline,
single PostGIS table {sync_target.table} keyed on {sync_target.id_field}.
Design the change log, push/pull/ack endpoints, and conflict handling. Flag
anywhere the requested policy loses data and propose the safer alternative.

### 2. Generate sync engine code

System: You are a React Native TypeScript engineer implementing a specified
sync design exactly. No deviations from the provided endpoint spec. Strict
types, no `any`. All network calls must be cancellable and retried with
exponential backoff capped at 5 minutes. Output only file contents.

User: Endpoint spec: {endpoint_spec_json}. Change log schema:
{change_log_schema_json}. Conflict design: {conflict_design_json}. Write
`src/sync/SyncEngine.ts` and `src/sync/api.ts` implementing push, pull, ack,
and conflict resolution, triggered by NetInfo reconnect events and a manual
"Sync now" action.

## Failure modes

- `sync_target.api_base_url` is a raw database connection string → hard fail
  with the reason (credential + boundary risk); suggest fronting PostGIS with
  PostgREST or a thin API
- Schema contains a geometry type SQLite layer can't index efficiently for the
  expected volume (e.g. large polygons, >50k features) → proceed, but
  `architecture_notes` documents the risk and recommends tile-based reference
  layers instead of syncing full geometries
- `tsc --noEmit` fails after repair pass → deliver scaffold marked degraded
  with errors attached; capture flow files are still usable for review
- Requested `conflict_policy` is `client-wins` on a shared table → do not
  silently apply; emit the recommendation step's warning in
  `architecture_notes` and `next_steps`, and require the operator to confirm
  before first sync against production

## Cost + timeout

- Max cost per invocation: $1.00
- Max duration: 600 seconds
- Typical actual cost: $0.50, typical duration: 300 seconds
