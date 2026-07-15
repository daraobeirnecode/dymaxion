---
slug: deck-gl-viz
name: Deck.gl Visualization Generator
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Deck.gl Visualization Generator

## Purpose

Generate a self-contained Deck.gl 9.x visualization from a dataset plus a
rendering intent expressed in plain language ("show trip density as hexbins",
"arcs from origin to destination"). Picks the right layer type
(HexagonLayer, ArcLayer, TripsLayer, ScatterplotLayer, HeatmapLayer,
GeoJsonLayer), configures accessors from the dataset's actual columns, and
emits a runnable single-page app over a MapLibre basemap.

## When to use this skill

- User wants a data visualization on a map: density, flows, trips over time,
  point clouds, 3D extrusion
- Dataset is medium-large (10k–5M rows) where SVG/canvas map libs choke
- User names Deck.gl or asks for a "kepler-style" look

## When NOT to use this skill

- User needs a full application with routing/state — use
  `nextjs-map-app-scaffold` with `map_library: deckgl`
- Cartographic styling of vector tile layers, no aggregation/WebGL effects —
  use `maplibre-scene-builder`
- 3D terrain, buildings, or photorealistic tiles — use `cesium-3d-scene`

## Inputs

- `dataset_path` (string, required): path to CSV, GeoJSON, or Parquet file
- `rendering_intent` (string, required): plain-language description of the
  desired visualization
- `output_dir` (string, required): directory to write the viz project into
- `layer_type` (string, optional): force a specific layer
  (`hexagon | arc | trips | scatterplot | heatmap | geojson`); otherwise
  inferred from `rendering_intent` + dataset shape
- `color_field` (string, optional): column driving the color scale
- `title` (string, optional): page title. Default derived from dataset filename

## Outputs

- `project_path` (string): directory containing the generated viz
- `files_created` (array): relative paths written (`index.html`, `app.js`,
  `data/` copy or reference)
- `layer_config` (object): the chosen layer type and its accessor/prop config
- `next_steps` (array): how to serve locally, tuning knobs (radius, elevation)

## Tools required

- `filesystem-mcp` — read dataset header/sample, write viz files
- `npm` — optional bundle step when the dataset requires Parquet loaders

## Execution plan

1. Read dataset header + a 200-row sample; detect columns, types, and the
   coordinate columns (lon/lat pairs, WKT, or GeoJSON geometry)
2. Choose layer type: honor `layer_type` if given, else map intent keywords and
   data shape (origin+destination columns → arc, timestamp column → trips,
   point density language → hexagon/heatmap)
3. Generate `app.js` (LLM step below): Deck.gl instance with the chosen layer,
   accessors bound to detected columns, MapLibre interleaved basemap, tooltip
   showing the top attributes, and an initial view state fitted to data bounds
4. Write `index.html` loading deck.gl + maplibre-gl from pinned ESM CDN imports
   (no build step for CSV/GeoJSON; Parquet triggers a Vite mini-bundle)
5. Copy or symlink the dataset under `project_path/data/`
6. Smoke-check: parse generated JS with `node --check`; verify data columns
   referenced in accessors all exist
7. Return `project_path`, `files_created`, `layer_config`, `next_steps`

## LLM prompts

### Generate visualization code

System: You are a Deck.gl 9.x specialist. Write modern ESM JavaScript, no
framework. Accessors must reference only the provided column names. Choose
color ranges that are colorblind-safe. Output only code.

User: Dataset columns: {columns_json}. Sample rows: {sample_rows}. Coordinate
columns: {coord_columns}. Intent: "{rendering_intent}". Layer: {layer_type}.
Color by: {color_field}. Write `app.js` creating a Deck instance over a MapLibre
basemap with this layer, a tooltip, and initialViewState fitted to
{data_bounds}.

## Failure modes

- No coordinate columns detectable → fail with the column list and a hint to
  pass explicit lon/lat column names via `rendering_intent`
- Intent is ambiguous between two layer types → pick the simpler one, state the
  choice and the alternative in `next_steps` rather than blocking
- Dataset larger than 500MB → subsample to 1M rows for the generated viz, note
  the subsampling and recommend tiling in `next_steps`
- Generated JS fails `node --check` → one LLM repair pass with the syntax
  error; then fail with the error attached

## Cost + timeout

- Max cost per invocation: $0.30
- Max duration: 600 seconds
- Typical actual cost: $0.15, typical duration: 60 seconds
