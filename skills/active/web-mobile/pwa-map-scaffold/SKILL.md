---
slug: pwa-map-scaffold
name: PWA Map Scaffold
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# PWA Map Scaffold

## Purpose

Scaffold a Progressive Web App with MapLibre GL JS plus a Service Worker that
caches the app shell, the style JSON, glyphs/sprites, and tiles for named
regions — installable from the browser and usable offline. The no-app-store
alternative to `expo-map-scaffold`.

## When to use this skill

- User wants offline-capable maps without native app distribution ("works on
  any phone from a link")
- IT policy or timeline rules out app-store / MDM deployment
- Mixed device fleet (iOS + Android + tablets + desktops) with one codebase

## When NOT to use this skill

- Background GPS tracking, reliable camera-heavy capture, or large offline
  areas are needed — browser storage quotas (~60% of disk on Chromium,
  much stricter on iOS Safari) make `expo-map-scaffold` or `field-mapping-app`
  the honest choice
- No offline requirement at all — plain `nextjs-map-app-scaffold` is simpler
- ArcGIS layers requiring authenticated access — token handling in a SW cache
  is a security footgun; use the ArcGIS SDK path instead

## Inputs

- `project_name` (string, required): npm-safe package name
- `output_dir` (string, required): parent directory for the project
- `basemap_style` (string, optional): MapLibre style URL. Default
  `https://demotiles.maplibre.org/style.json`
- `layers` (array, optional): overlay descriptors `{ url, type, title }`
  (GeoJSON or vector tile) added above the basemap
- `cache_regions` (array, optional): offline regions
  `{ name, bounds: [w, s, e, n], min_zoom, max_zoom }` the SW pre-caches on
  user request
- `app_title` (string, optional): manifest name + header. Default from
  `project_name`
- `theme_color` (string, optional): manifest/UI theme hex. Default `#1f2937`

## Outputs

- `project_path` (string): absolute path to the scaffolded project
- `files_created` (array): relative paths written
- `dev_command` (string): command to serve locally (SW requires http origin)
- `cache_estimate` (object): per-region estimated tile count + MB at the
  configured zoom range
- `next_steps` (array): HTTPS hosting requirement, iOS storage caveats, icon
  replacement

## Tools required

- `filesystem-mcp` — write project files
- `npm` — install `maplibre-gl`, `vite`, `vite-plugin-pwa`; verify build

## Execution plan

1. Validate `project_name`; refuse if target exists; estimate tile counts for
   each `cache_regions` entry (Web Mercator tile math per zoom) and warn above
   50MB per region
2. Write Vite + TypeScript scaffold: `index.html`, `vite.config.ts` with
   `vite-plugin-pwa` (injectManifest strategy), `manifest.webmanifest` with
   `app_title`, `theme_color`, and placeholder maskable icons
3. Generate `src/main.ts` (LLM step below): MapLibre map with `basemap_style`,
   overlay `layers`, an offline-region panel listing `cache_regions` with
   download/progress/delete, and an online/offline status indicator
4. Generate `src/sw.ts`: precache app shell; runtime cache-first for style,
   glyphs, sprites; a `REGION_DOWNLOAD` message handler that enumerates tile
   URLs for a region's bounds/zooms and stores them in a named Cache; LRU-style
   eviction when `navigator.storage.estimate()` nears quota
5. `npm install` and `npm run build`; verify the SW compiles and the precache
   manifest is generated
6. Return outputs including `cache_estimate`

## LLM prompts

### Generate app + service worker

System: You are a PWA + MapLibre engineer. Strict TypeScript. The service
worker must never cache POST requests or authenticated responses, must version
its caches, and must fail soft (network fallthrough) on cache errors. Output
only file contents, one file per fenced block with its path.

User: Style: {basemap_style}. Overlays: {layers_json}. Regions:
{cache_regions_json} (tile URL template extracted from the style's sources).
Write `src/main.ts` (map, overlays, offline panel with per-region download
progress and delete) and `src/sw.ts` (precache + runtime caching + region tile
download via message handler, cache name prefix "{project_name}").

## Failure modes

- Style JSON unreachable at scaffold time → scaffold anyway with the URL wired
  and add a `next_steps` warning; offline download will validate at runtime
- Region tile estimate exceeds 200MB → cap `max_zoom` for that region to bring
  it under the cap, record original vs adjusted in `cache_estimate`
- `vite-plugin-pwa` build fails on generated `sw.ts` → one LLM repair pass with
  the build error; then fail with the error attached and app-shell-only SW as
  fallback
- Basemap tile server lacks CORS headers → detected during build smoke fetch;
  warn in `next_steps` that offline caching of that source will fail and
  suggest a proxy

## Cost + timeout

- Max cost per invocation: $0.50
- Max duration: 600 seconds
- Typical actual cost: $0.25, typical duration: 180 seconds
