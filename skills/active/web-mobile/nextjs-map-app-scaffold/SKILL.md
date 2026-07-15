---
slug: nextjs-map-app-scaffold
name: Next.js Map App Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Next.js Map App Scaffold

## Purpose

Scaffold a Next.js 15 App Router project wired to one of three map libraries —
ArcGIS Maps SDK for JavaScript, MapLibre GL JS, or Deck.gl — selected by the
`map_library` parameter. Produces a working full-screen map page with one
configured layer and a click popup, ready for `npm run dev`.

## When to use this skill

- User asks for a "new map app", "web map project", or "map website" from scratch
- User names Next.js, React, or "modern web stack" for a mapping front-end
- A downstream skill (e.g. `arcgis-maps-sdk-integration`) needs a host project
  that does not exist yet

## When NOT to use this skill

- An existing Next.js project should gain map capability — use
  `arcgis-maps-sdk-integration` instead of scaffolding a second project
- The deliverable is a standalone visualization, not an app — use `deck-gl-viz`
- Offline/PWA requirements dominate — use `pwa-map-scaffold`
- Mobile-native is required — use `expo-map-scaffold`

## Inputs

- `project_name` (string, required): npm-safe package name, e.g. `parcel-viewer`
- `output_dir` (string, required): parent directory; project is created at
  `{output_dir}/{project_name}`
- `map_library` (string, required): one of `arcgis`, `maplibre`, `deckgl`
- `basemap_style` (string, optional): style URL or well-known basemap id.
  Defaults: `arcgis/topographic` (ArcGIS), `https://demotiles.maplibre.org/style.json`
  (MapLibre/Deck.gl)
- `layers` (array, optional): layer descriptors `{ url, type, title }` to add to
  the initial map. Default: none (basemap only)
- `typescript` (boolean, optional, default true): emit `.tsx` + `tsconfig.json`

## Outputs

- `project_path` (string): absolute path to the scaffolded project
- `files_created` (array): relative paths of every file written
- `dev_command` (string): command to start the dev server
- `next_steps` (array): human-readable follow-ups (set API key, add layers, deploy)

## Tools required

- `filesystem-mcp` — write project files
- `npm` — `npm install`, `npm run build` verification

## Execution plan

1. Validate `project_name` against npm name rules; validate `map_library` is one
   of the three supported values; refuse if `{output_dir}/{project_name}` exists
2. Create directory tree: `app/`, `app/map/`, `components/`, `public/`
3. Write `package.json` pinning `next@15`, `react@19`, and the chosen map dep
   (`@arcgis/core@^4`, `maplibre-gl@^5`, or `deck.gl@^9` + `maplibre-gl`)
4. Write `next.config.ts`, `tsconfig.json`, `app/layout.tsx`, `app/page.tsx`
5. Generate the map component (LLM step below): a client component
   (`"use client"`) mounting the map in a `useEffect`, adding `layers`, and
   wiring a click popup; CSS for a full-viewport map container
6. Run `npm install` in the project directory
7. Run `npm run build`; on success capture output, on failure enter the
   fix loop (Failure modes)
8. Return `project_path`, `files_created`, `dev_command`, `next_steps`

## LLM prompts

### Generate map component

System: You are a senior React + GIS engineer. Emit a single complete Next.js 15
client component in strict TypeScript for the requested map library. No
placeholder comments, no unused imports. The map must fill the viewport, clean
up on unmount, and guard against double-mount under React StrictMode.

User: Library: {map_library}. Basemap: {basemap_style}. Layers: {layers_json}.
Write `components/MapView.tsx` that renders the basemap, adds each layer, and
shows an attribute popup on feature click. Include the required CSS import for
the library. Target Next.js 15 App Router with `"use client"`.

## Failure modes

- Target directory already exists → abort before writing anything; report the
  path and suggest a different `project_name`
- `npm install` fails (network/registry) → retry once after 15s; on second
  failure return partial scaffold with `next_steps` instructing manual install
- `npm run build` fails on generated component → feed the compiler error back to
  the LLM for one repair pass; if still failing, return scaffold with the error
  attached and mark the run degraded
- ArcGIS SDK chosen but no API key configured → scaffold with
  `NEXT_PUBLIC_ARCGIS_API_KEY` read from env and add a `next_steps` item; do not
  fail

## Cost + timeout

- Max cost per invocation: $0.60
- Max duration: 600 seconds (npm install dominates)
- Typical actual cost: $0.30, typical duration: 180 seconds
