---
slug: arcgis-maps-sdk-integration
name: ArcGIS Maps SDK Integration
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# ArcGIS Maps SDK Integration

## Purpose

Add ArcGIS Maps SDK for JavaScript 4.x capability to an **existing** Next.js
project: install `@arcgis/core`, add FeatureLayers/MapImageLayers, mount widgets
(Legend, LayerList, Search, Editor, etc.), and wire interactions such as popups
and highlight-on-hover. Modifies files in place rather than scaffolding.

## When to use this skill

- User has a Next.js project and wants ArcGIS layers or widgets added to it
- User asks to "add a FeatureLayer", "add a Legend/Search widget", or "hook up
  our portal layers" in an existing app
- `nextjs-map-app-scaffold` already ran with `map_library: arcgis` and the user
  now wants more layers/widgets/interactions

## When NOT to use this skill

- No project exists yet — run `nextjs-map-app-scaffold` first
- The project uses MapLibre or Deck.gl and the user has not asked to switch;
  mixing SDKs in one map view is not supported
- The target framework is not Next.js/React (Vue, Angular, plain HTML) —
  propose `skill-draft` for a framework-specific variant

## Inputs

- `project_dir` (string, required): absolute path to the existing Next.js project
- `layers` (array, required): descriptors `{ url, type, title, popup_fields? }`;
  `type` is one of `feature`, `map-image`, `vector-tile`, `imagery`
- `widgets` (array, optional): widget names from the 4.x catalog, e.g.
  `["Legend", "LayerList", "Search"]`. Default: `["Legend"]`
- `interactions` (array, optional): `popup`, `highlight`, `hitTest-log`.
  Default: `["popup"]`
- `api_key_env` (string, optional): env var name holding the ArcGIS API key.
  Default `NEXT_PUBLIC_ARCGIS_API_KEY`

## Outputs

- `files_created` (array): new files written (e.g. `components/ArcgisMap.tsx`)
- `files_modified` (array): existing files edited (e.g. `package.json`, pages)
- `layers_added` (array): titles of layers successfully wired
- `next_steps` (array): follow-ups (set API key, check layer sharing level)

## Tools required

- `filesystem-mcp` — read existing project, write/edit files
- `npm` — install `@arcgis/core`, verify with `npm run build`

## Execution plan

1. Verify `project_dir` contains `package.json` with a `next` dependency; detect
   App Router vs Pages Router and existing map component if any
2. Validate each layer URL shape (`/FeatureServer/{n}`, `/MapServer`, etc.)
   against its declared `type`; reject mismatches before touching files
3. `npm install @arcgis/core@^4` if not already a dependency
4. Generate or extend the map client component (LLM step below): esConfig
   apiKey from `api_key_env`, one SDK layer instance per input layer, requested
   widgets added to `view.ui`, requested interactions wired
5. Import `@arcgis/core/assets/esri/themes/light/main.css` and ensure
   `next.config` transpiles/serves SDK assets correctly
6. Run `npm run build`; on failure, one LLM repair pass with compiler output
7. Return created/modified file lists, `layers_added`, `next_steps`

## LLM prompts

### Generate/extend ArcGIS map component

System: You are an ArcGIS Maps SDK for JavaScript 4.x expert working in a
Next.js client component. Use modular `@arcgis/core` imports only — never the
CDN. Preserve any existing code you are extending; add, do not rewrite. Strict
TypeScript, cleanup in the effect return, StrictMode-safe.

User: Project uses {router_type} router. Existing map component:
{existing_component_or_none}. Add these layers: {layers_json}. Add widgets:
{widgets} (positions: sensible defaults, Legend bottom-left). Wire interactions:
{interactions}. API key comes from process.env.{api_key_env}. Return the full
updated component file.

## Failure modes

- `project_dir` is not a Next.js project → fail fast with what was found
  (missing `package.json` or no `next` dependency); no files touched
- Layer URL unreachable or requires auth → still wire the layer, add a
  `next_steps` warning naming the layer and HTTP status; do not fail the run
- Build fails after integration → one repair pass; if still failing, revert
  modified files from pre-run backups and report the compiler error
- Widget name not in the 4.x catalog → drop that widget, list it in
  `next_steps` with the closest valid name

## Cost + timeout

- Max cost per invocation: $0.30
- Max duration: 600 seconds
- Typical actual cost: $0.15, typical duration: 120 seconds
