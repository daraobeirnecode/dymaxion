---
slug: arcpy-script-runner
name: ArcPy Script Runner
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# ArcPy Script Runner

## Purpose

Execute a registered arcpy script on the Windows Worker with specified
parameters. Input and output files are shuttled between the runtime and the
worker over Tailscale. The skill defines the script catalog — arbitrary code
is never executed. Destructive when the script writes outside worker scratch.

## When to use this skill

- The requested geoprocessing needs arcpy specifically (Esri formats, SDE,
  network datasets, tools with no GDAL/QGIS equivalent)
- A registered script exists for the operation (`script_slug` resolves in the
  catalog)

## When NOT to use this skill

- Format conversion or reprojection that GDAL handles — use
  `gdal-format-convert` / `gdal-raster-warp` (cheaper, no worker dependency)
- Editing an ArcGIS Pro project — use `arcgis-pro-project-editor`
- The script is not in the registered catalog — draft it via `skill-draft`
  and register it first; never run ad-hoc code on the worker

## Inputs

- `script_slug` (string, required): key of a registered script in this
  skill's catalog, e.g. `clip-and-project`
- `parameters` (object, required): named parameters the script declares
- `input_paths` (array, optional): files to stage onto the worker before the
  run
- `output_dir` (string, optional): worker-side output directory. Default:
  worker scratch (`C:/dymaxion/scratch`)

## Outputs

- `output_paths` (array): worker-side paths of declared outputs, retrieved
  back to the runtime staging area
- `execution_log` (string): combined stdout/stderr plus geoprocessing
  messages, with an LLM diagnosis appended on failure

## Tools required

- `windows-worker` — job API over Tailscale (stage files, run script, poll,
  retrieve outputs)

## Execution plan

1. Resolve `script_slug` against the registered catalog; reject unknown slugs
2. Validate `parameters` against the script's declared parameter schema
3. Pre-flight check: if the script's declared write scope is outside worker
   scratch, this run is destructive — request operator approval first
4. Stage `input_paths` to the worker over Tailscale; verify checksums
5. Submit the job to the windows-worker API; stream stdout/stderr
6. Poll until completion or the 600-second ceiling
7. Retrieve declared outputs; on non-zero exit, run the workhorse LLM
   diagnosis over the log tail
8. Return `output_paths` + `execution_log`

## LLM prompts

### Failure diagnosis (workhorse tier)

System: You read arcpy tracebacks and geoprocessing messages. Reply with:
the failing tool name, the cause in one sentence, and one concrete fix. Do
not speculate beyond what the log shows.

User: Script {script_slug} exited with code {exit_code}. Parameters:
{parameters_json}. Log tail (last 200 lines): {log_tail}. Diagnose.

## Failure modes

- Worker offline (Tailscale down or service stopped) — fail fast with the
  worker health endpoint URL; do not queue silently
- arcpy license unavailable (Pro session holds it) — wait 60s, retry once,
  then fail telling the operator to close ArcGIS Pro
- Script exceeds the 600s ceiling — worker kills the process; partial
  outputs are quarantined in scratch and listed in `execution_log`
- Output path collision — never overwrite; the worker suffixes a timestamp
  and the real path is reported in `output_paths`

## Cost + timeout

- Max cost per invocation: $0.30 (budget cap)
- Max duration: 600 seconds
- Typical actual cost: $0.15, typical duration: 60-300 seconds depending on
  the geoprocessing tool
