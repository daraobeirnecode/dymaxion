---
slug: qgis-project-editor
name: QGIS Project Editor
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# QGIS Project Editor

## Purpose

Open an existing QGIS project (`.qgz`), apply a declared list of edits — add or
remove layers, set symbology from `.qml` styles, reorder the layer tree, adjust
layout elements — and save the project back to disk. Destructive: it rewrites a
user file, so it always runs behind an approval gate and takes a backup first.

## When to use this skill

- The user asks to add/remove/restyle layers in a named `.qgz` project
- Batch updates: repoint layer sources after a data migration, swap a style
  across several projects
- Preparing a project so `qgis-map-export` can render a layout from it

## When NOT to use this skill

- One-off geoprocessing with no project involved — use `qgis-algorithm-runner`
- Only rendering an existing layout, no edits — use `qgis-map-export`
- Creating a brand-new project from scratch with many design decisions — draft
  the layer list first, get approval, then invoke this skill with explicit edits

## Inputs

- `project_path` (string, required): absolute path to the `.qgz` file
- `edits` (array, required): ordered edit operations; each item is
  `{action, ...}` where action ∈ `add_layer | remove_layer | set_symbology |
  reorder | set_layout_item | repoint_source`
- `backup` (boolean, optional, default true): copy the project to
  `<project>.bak-<timestamp>.qgz` before writing

## Outputs

- `project_path` (string): path of the saved project
- `applied_edits` (array): the edits actually applied, in order, with per-edit status
- `backup_path` (string): path of the pre-edit backup (empty if `backup: false`)

## Tools required

- `cli-anything-qgis` — headless PyQGIS session against the project file

## Execution plan

1. Verify `project_path` exists and is a readable `.qgz`; refuse paths outside
   the workspace allowlist
2. Raise an approval request describing every edit (this skill is destructive)
3. Copy the project to a timestamped backup unless `backup: false`
4. Open the project in a headless PyQGIS session
5. Apply edits in order; validate each (layer source resolves, `.qml` parses,
   layout item exists) before mutating; stop at first hard failure
6. Save the project; reopen it read-only to confirm it loads cleanly
7. Return applied edits + backup path

## LLM prompts

### Translate an edit request into edit operations (workhorse tier)

System: You convert QGIS project-edit requests into a JSON array of edit
operations. Allowed actions: add_layer, remove_layer, set_symbology, reorder,
set_layout_item, repoint_source. Reference only layers listed in the project
inventory provided. Output JSON only.

User: Project inventory: {layer_tree_json}. Layouts: {layouts}. Request:
{user_request}. Produce the ordered edits array.

## Failure modes

- Project fails to open (corrupt or version-incompatible) → do not write
  anything; report QGIS version + error, suggest opening in QGIS Desktop
- An edit references a missing layer/style file → stop before that edit, keep
  earlier valid edits unsaved, report which reference is broken, exit non-zero
- Save succeeds but re-open validation fails → restore from backup automatically
  and report the diff of what was attempted
- Approval denied → exit cleanly with `applied_edits: []`, no file touched

## Cost + timeout

- Max cost per invocation: $0.30
- Max duration: 300 seconds
- Typical actual cost: $0.15, typical duration: 30-90 seconds
