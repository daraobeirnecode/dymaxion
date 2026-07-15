---
slug: expo-map-scaffold
name: Expo Map Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Expo Map Scaffold

## Purpose

Scaffold an Expo (React Native) mobile app with MapLibre GL Native
(`@maplibre/maplibre-react-native`) and offline tile support: a map screen,
style loading, and an offline-region download manager for user-selected
bounding boxes. Produces a project runnable in Expo Dev Client (native module
requires a development build, not Expo Go).

## When to use this skill

- User asks for a "mobile map app", "iOS/Android map", or names React
  Native/Expo
- Offline basemap viewing in the field is a requirement but full data
  capture/sync is not
- A quick native shell is needed before deciding on the heavier
  `field-mapping-app`

## When NOT to use this skill

- Data capture with offline edits and PostGIS sync is required — use
  `field-mapping-app` (this skill is view-only offline)
- A browser-based solution is acceptable — `pwa-map-scaffold` avoids app-store
  distribution entirely
- The org mandates ArcGIS Field Maps — configuration task, not a scaffold

## Inputs

- `project_name` (string, required): Expo app slug, e.g. `field-viewer`
- `output_dir` (string, required): parent directory for the project
- `style_url` (string, optional): MapLibre style URL for the basemap. Default
  `https://demotiles.maplibre.org/style.json`
- `offline_regions` (array, optional): preconfigured regions
  `{ name, bounds: [w, s, e, n], min_zoom, max_zoom }` selectable for download
- `initial_center` (array, optional): `[lon, lat]`. Default `[0, 0]`
- `initial_zoom` (number, optional): default 2

## Outputs

- `project_path` (string): absolute path to the scaffolded project
- `files_created` (array): relative paths written
- `run_commands` (array): ordered commands (`npx expo prebuild`,
  `npx expo run:android` / `run:ios`)
- `next_steps` (array): dev-build caveats, tile-usage/licensing check for the
  chosen style, region size guidance

## Tools required

- `filesystem-mcp` — write project files
- `npm` — `npx create-expo-app`, dependency install

## Execution plan

1. Validate `project_name` (Expo slug rules); refuse if target directory exists
2. Run `npx create-expo-app` with the TypeScript template into
   `{output_dir}/{project_name}`
3. Install `@maplibre/maplibre-react-native`; add its config plugin to
   `app.json` and set required Android/iOS location permissions strings
4. Generate `src/screens/MapScreen.tsx` (LLM step below): MapView with
   `style_url`, camera at `initial_center`/`initial_zoom`, user-location puck
5. Generate `src/offline/OfflineManager.ts` + a regions screen: list
   `offline_regions`, download via `OfflineManager.createPack`, show progress
   and pack size, delete packs
6. Wire both screens with `expo-router` tabs (Map / Offline)
7. Run `npx tsc --noEmit` to verify types (native build is out of scope for
   the scaffold run)
8. Return `project_path`, `files_created`, `run_commands`, `next_steps`

## LLM prompts

### Generate map + offline screens

System: You are a React Native + MapLibre Native engineer. Target
`@maplibre/maplibre-react-native` v10 API with Expo SDK 52+, strict TypeScript,
expo-router. Offline packs must report progress via the pack observer, not
polling. Output only file contents, one file per fenced block with its path.

User: Style URL: {style_url}. Initial camera: {initial_center} z{initial_zoom}.
Preconfigured regions: {offline_regions_json}. Write `MapScreen.tsx` (map +
location puck) and `OfflineManager.ts` + `OfflineScreen.tsx` (list, download
with progress, delete). Handle the no-connectivity case by loading the last
downloaded pack's region.

## Failure modes

- `create-expo-app` fails (network/registry) → retry once after 15s; on second
  failure abort with nothing written outside the scratch attempt
- MapLibre config plugin version incompatible with installed Expo SDK → pin the
  last known-good pair from the skill's compatibility table, note the pin in
  `next_steps`
- `tsc --noEmit` errors in generated screens → one LLM repair pass with the
  error output; if still failing, deliver the scaffold with errors listed and
  mark the run degraded
- `offline_regions` bounds exceed ~2GB tile estimate at requested zooms → keep
  the region but cap `max_zoom` to fit, record the adjustment in `next_steps`

## Cost + timeout

- Max cost per invocation: $0.60
- Max duration: 600 seconds
- Typical actual cost: $0.30, typical duration: 240 seconds
