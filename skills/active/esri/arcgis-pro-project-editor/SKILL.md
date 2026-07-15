---
slug: arcgis-pro-project-editor
name: ArcGIS Pro Project Editor
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# ArcGIS Pro Project Editor

## Purpose

Open an ArcGIS Pro project (.aprx) on the Windows Worker via
CLI-Anything-Arcgis-Pro, apply an ordered list of operations — add layer,
set symbology, reproject a map, add to layout, remove layer, set extent —
and save. Destructive: writes to the project file.

## When to use this skill

- User asks to modify an existing .aprx: "add this layer to the basemap
  project", "recolor the hydrants layer", "add the map to the letter layout"
- Batch project maintenance across known operations in the supported
  vocabulary

## When NOT to use this skill

- Running geoprocessing tools — use `arcpy-script-runner`
- Creating a project from scratch — out of scope for Sprint 1
- Operations outside the supported vocabulary (e.g. editing geodatabase
  data) — the op validator will reject them; use the appropriate data skill
- QGIS projects — use `qgis-project-editor`

## Inputs

- `project_path` (string, required): worker-side path to the .aprx
- `operations` (array, required): ordered list of `{op, params}` objects;
  `op` is one of `add_layer`, `set_symbology`, `reproject_map`,
  `add_to_layout`, `remove_layer`, `set_extent`
- `backup` (boolean, optional): copy the .aprx aside before editing.
  Default true

## Outputs

- `modified_project_path` (string): path of the saved project on the worker
- `operation_results` (array): per-operation status (applied / failed /
  skipped) with the CLI output for each

## Tools required

- `windows-worker` — hosts ArcGIS Pro and CLI-Anything-Arcgis-Pro; reached
  over Tailscale

## Execution plan

1. Verify the project exists on the worker and is not lock-held by an open
   Pro session (.lock file check)
2. If `backup`, copy the .aprx to `{project_path}.bak-{timestamp}`
3. Validate every entry in `operations` against the supported op vocabulary
   and required params; reject the whole batch on any unknown op
4. Read the project inventory (maps, layers, layouts) via
   CLI-Anything-Arcgis-Pro
5. Workhorse LLM compiles the operations into a concrete CLI command
   sequence using exact names from the inventory
6. Approval gate — project write is destructive; the summary shows each
   command and any fuzzy-matched layer names
7. Execute the sequence; capture per-op results; stop on first failure
8. Save, then verify the project reopens headlessly; return outputs

## LLM prompts

### Command compilation (workhorse tier)

System: You translate project-edit intents into CLI-Anything-Arcgis-Pro
commands. Use only exact map, layer, and layout names from the provided
inventory. If a requested name has no exact match, pick the closest
candidate and mark it FUZZY with the original request. Output only the
ordered command list as JSON.

User: Project inventory: {inventory_json}. Requested operations:
{operations_json}. Emit the command sequence.

## Failure modes

- .aprx locked by an open ArcGIS Pro session — fail immediately, telling
  the operator which machine holds the lock and to close Pro
- An operation fails mid-sequence — stop, restore the backup, and report
  which operations completed vs failed in `operation_results`
- Layer name in `operations` has no confident inventory match — the FUZZY
  mark surfaces in the approval summary; the operator decides before
  anything runs
- Saved project fails the headless reopen check — restore the backup
  automatically and fail with the CLI error

## Cost + timeout

- Max cost per invocation: $0.60 (budget cap)
- Max duration: 600 seconds (excluding operator approval wait)
- Typical actual cost: $0.30, typical duration: 90-180 seconds
