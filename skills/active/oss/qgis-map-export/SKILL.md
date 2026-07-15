---
slug: qgis-map-export
name: QGIS Map Export
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# QGIS Map Export

## Purpose

Render a named print layout from a QGIS project to PNG, PDF, or SVG at a
specified DPI. Supports batch export: pass `layout_name: "*"` to render every
layout in the project, or use atlas-enabled layouts to emit one file per atlas
feature. Read-only with respect to the project file.

## When to use this skill

- The user wants a map image/PDF from an existing `.qgz` layout
- Batch deliverables: "export all layouts at 300 DPI as PDF"
- Atlas runs: one map per parcel/district/sheet from an atlas layout

## When NOT to use this skill

- The layout needs changes first (title, extent, layers) — run
  `qgis-project-editor`, then this skill
- No QGIS project exists and the user just wants a quick data preview — use
  `qgis-algorithm-runner` or a web-map skill instead of building a layout

## Inputs

- `project_path` (string, required): absolute path to the `.qgz` file
- `layout_name` (string, required): layout to render; `"*"` renders all layouts
- `format` (string, optional, default `pdf`): one of `png | pdf | svg`
- `dpi` (number, optional, default 300): render resolution
- `output_dir` (string, optional, default `/workspace/exports`): destination
  directory; files named `<project>-<layout>[-<atlas-key>].<ext>`

## Outputs

- `exported_files` (array): absolute paths of every rendered file
- `render_log` (string): renderer messages (missing layers, font substitutions)

## Tools required

- `cli-anything-qgis` — headless layout renderer (QgsLayoutExporter)

## Execution plan

1. Open the project read-only; list layouts; resolve `layout_name` (exact match,
   else case-insensitive match, else fail with the available names)
2. Check every layer in the layout resolves; collect broken-source warnings
3. If the layout has an atlas, enumerate atlas features and plan one output per
   feature; cap at 200 pages without explicit override
4. Render with QgsLayoutExporter at the requested DPI/format into `output_dir`
5. Verify each output file exists and exceeds 1 KB; flag blank renders
6. Return file list + render log

## LLM prompts

### Resolve ambiguous export request (classification tier)

System: You select export parameters for a QGIS layout render. Output JSON only:
{"layout_name": ..., "format": ..., "dpi": ...}. Choose from the provided layout
names; never invent one. Default pdf/300 when unstated.

User: Available layouts: {layout_names}. Request: {user_request}.

## Failure modes

- Layout name not found → return the project's actual layout list in the error;
  do not guess-render a different layout
- Broken layer sources in the layout → render anyway but list every broken layer
  in `render_log` and mark the run as degraded
- Atlas exceeds the 200-page cap → stop before rendering, report the count, ask
  for an explicit page range or override
- Output file rendered but ~blank (below size threshold) → retry once at the
  layout's default extent, then fail with a hint that the extent may be empty

## Cost + timeout

- Max cost per invocation: $0.06
- Max duration: 300 seconds
- Typical actual cost: $0.03, typical duration: 10-60 seconds (per layout)
