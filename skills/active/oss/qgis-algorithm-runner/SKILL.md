---
slug: qgis-algorithm-runner
name: QGIS Algorithm Runner
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# QGIS Algorithm Runner

## Purpose

Run any QGIS processing algorithm (native, GDAL, GRASS, SAGA providers) headlessly
via `cli-anything-qgis`, given the algorithm identifier (e.g. `native:buffer`,
`qgis:joinattributesbylocation`) and a parameter map. Returns the output dataset
path and the processing log.

## When to use this skill

- A single, well-defined geoprocessing step is needed: buffer, clip, dissolve,
  spatial join, zonal statistics, raster calculator, etc.
- The user names a QGIS algorithm or describes an operation that maps 1:1 to one
- A chain of steps where each step is one algorithm invocation (invoke repeatedly)

## When NOT to use this skill

- The operation is pure format conversion or reprojection — use
  `gdal-format-convert` / `gdal-raster-warp` (cheaper, no QGIS startup cost)
- The task requires editing a `.qgz` project, symbology, or layouts — use
  `qgis-project-editor` or `qgis-map-export`
- The dataset is very large (tens of millions of features) — use
  `duckdb-spatial-analytics` or `sedona-spark-analytics`

## Inputs

- `algorithm` (string, required): QGIS algorithm id, e.g. `native:buffer`
- `parameters` (object, required): algorithm parameter map exactly as
  `qgis_process` expects it (INPUT, OUTPUT, and algorithm-specific keys)
- `output_path` (string, optional): expected primary output path; defaults to the
  `OUTPUT` entry inside `parameters`

## Outputs

- `output_path` (string): path to the primary output dataset
- `algorithm_log` (string): captured stdout/stderr from the processing run

## Tools required

- `cli-anything-qgis` — wraps `qgis_process run` in the QGIS container

## Execution plan

1. Validate `algorithm` against `qgis_process list` output; reject unknown ids
2. Validate `parameters` keys against `qgis_process help <algorithm>` (LLM step
   only if the user gave a fuzzy description instead of exact parameters)
3. Confirm output path does not overwrite an existing user file; if it does,
   raise an approval request before running
4. Execute `qgis_process run <algorithm> -- <params>` with a hard wall-clock cap
5. Verify the output dataset exists and is non-empty (layer count / feature count)
6. Return `output_path` + trimmed `algorithm_log`

## LLM prompts

### Map fuzzy request to algorithm parameters (classification tier)

System: You map geoprocessing requests to QGIS processing algorithm calls.
Output only JSON: {"algorithm": "<provider:id>", "parameters": {...}}. Use exact
parameter names from the provided algorithm help text. Never invent parameters.

User: Request: {user_request}. Candidate algorithm help: {algorithm_help}.
Input dataset: {input_path} (geometry: {geom_type}, CRS: {crs}). Produce the call.

## Failure modes

- Algorithm id not found → run `qgis_process list`, fuzzy-match the closest 3
  ids, return them as suggestions instead of executing
- Parameter validation error from qgis_process → return the exact stderr line
  plus the algorithm's help text so the caller can correct the call; retry once
  if the fix is unambiguous (e.g. missing CRS)
- Output exists and `OUTPUT` would overwrite → halt, request approval, resume
  only on explicit confirmation
- QGIS container OOM on large raster → fail with dataset size + suggestion to
  tile the input or route to `gdal-raster-warp`

## Cost + timeout

- Max cost per invocation: $0.05
- Max duration: 300 seconds
- Typical actual cost: $0.02, typical duration: 15-60 seconds
