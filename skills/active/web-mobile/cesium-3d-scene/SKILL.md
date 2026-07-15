---
slug: cesium-3d-scene
name: Cesium 3D Scene Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Cesium 3D Scene Scaffold

## Purpose

Scaffold a CesiumJS 3D globe application with world terrain, an imagery layer,
and custom entities (points, polylines, polygons, 3D models). Optionally swaps
the globe for Google Photorealistic 3D Tiles. Produces a Vite + CesiumJS
project that runs with `npm run dev`.

## When to use this skill

- User asks for a "3D map", "globe", "terrain view", "flythrough", or
  "photorealistic city view"
- Deliverable needs vertical context: line-of-sight, viewsheds, tower siting,
  drone corridors, subsurface visualization
- User explicitly names Cesium, 3D Tiles, or Google Photorealistic Tiles

## When NOT to use this skill

- 2D web map is sufficient — use `nextjs-map-app-scaffold` (cheaper to run and
  to host)
- Only extruded data columns/hexbins are needed, not terrain — `deck-gl-viz`
  covers that without a Cesium ion account
- Target is mobile-native — no Cesium native path here; use `expo-map-scaffold`

## Inputs

- `project_name` (string, required): npm-safe package name
- `output_dir` (string, required): parent directory for the project
- `terrain` (boolean, optional, default true): enable Cesium World Terrain
- `imagery_provider` (string, optional): `cesium-ion | osm | arcgis-world-imagery`.
  Default `cesium-ion`
- `use_google_3d_tiles` (boolean, optional, default false): replace
  globe imagery with Google Photorealistic 3D Tiles (requires ion token with
  the Google tileset, asset 2275207)
- `entities` (array, optional): `{ type, name, positions, properties? }` where
  `type` is `point | polyline | polygon | model`
- `camera` (object, optional): `{ lon, lat, height_m, heading, pitch }` initial
  view. Default: fit to entities, else whole globe
- `ion_token_env` (string, optional): env var holding the Cesium ion token.
  Default `VITE_CESIUM_ION_TOKEN`

## Outputs

- `project_path` (string): absolute path to the scaffolded project
- `files_created` (array): relative paths written
- `dev_command` (string): command to start the dev server
- `next_steps` (array): set ion token, verify Google tiles quota, add entities

## Tools required

- `filesystem-mcp` — write project files
- `npm` — install `cesium`, `vite`, `vite-plugin-cesium`; verify build

## Execution plan

1. Validate `project_name`; refuse if target directory exists; if
   `use_google_3d_tiles` and `terrain` both true, disable terrain (Google tiles
   include their own) and note it in `next_steps`
2. Write `package.json` (cesium@^1, vite@^6, vite-plugin-cesium), `vite.config.ts`
   configured to copy Cesium static assets, `index.html`, `.env.example` with
   `{ion_token_env}=`
3. Generate `src/main.ts` (LLM step below): Viewer with terrain/imagery per
   params, entity creation for each input entity, camera setup, and a
   sandcastle-style flyTo on load
4. Write `src/style.css` for a full-viewport canvas and credit container
5. Run `npm install`, then `npm run build` to verify the bundle
6. Return `project_path`, `files_created`, `dev_command`, `next_steps`

## LLM prompts

### Generate scene code

System: You are a CesiumJS 1.1xx expert writing strict TypeScript for a Vite
project. Use the modular `cesium` package with `Ion.defaultAccessToken` from
import.meta.env. Never hardcode tokens. Heights in meters, positions as
Cartesian3.fromDegrees. Output only the file content.

User: Terrain: {terrain}. Imagery: {imagery_provider}. Google Photorealistic 3D
Tiles: {use_google_3d_tiles}. Entities: {entities_json}. Camera:
{camera_json}. Token env var: {ion_token_env}. Write `src/main.ts` creating the
Viewer, adding each entity with a label from its `name`, and flying the camera
to the configured view after load.

## Failure modes

- ion token env var unset at build time → scaffold still succeeds (token is
  runtime); add an explicit `next_steps` warning that the globe will render
  black without it
- Google 3D Tiles requested but asset load returns 401/403 in smoke test →
  fall back to World Terrain + imagery, record the degradation in `next_steps`
- Entity positions outside valid lon/lat ranges → drop the invalid entity,
  continue, and list it in `next_steps` with the offending coordinates
- `npm install` network failure → retry once after 15s, then return partial
  scaffold with manual-install instructions

## Cost + timeout

- Max cost per invocation: $0.40
- Max duration: 600 seconds
- Typical actual cost: $0.20, typical duration: 150 seconds
