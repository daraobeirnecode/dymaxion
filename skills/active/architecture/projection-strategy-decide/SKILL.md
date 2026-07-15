---
slug: projection-strategy-decide
name: Projection Strategy Decide
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Projection Strategy Decide

## Purpose

Recommend the coordinate reference system(s) for a project: geographic vs
projected, when to use Web Mercator vs local UTM vs state plane vs an
equal-area projection, and when to store data in multiple CRSs. Returns an
architecture doc framed as "recommend, with tradeoffs" — never a claim of
certainty.

## When to use this skill

- User asks "what projection should I use?" or "EPSG code for this project?"
- A project mixes analysis (area/distance) with web display and needs a
  storage-vs-display CRS strategy
- Measurements from an existing dataset look wrong and CRS choice is suspect

## When NOT to use this skill

- CRS already decided and data just needs reprojecting (use `gdal-raster-warp`
  or `gdal-format-convert`)
- Pure datum-transformation debugging on a single file (use GDAL skills directly)
- Whole-pipeline design where CRS is one of many decisions
  (use `data-pipeline-design`, which can call this skill)

## Inputs

- `project_description` (string, required): what the project does — analysis
  types, deliverables, precision needs
- `area_of_interest` (string, required): geographic extent, e.g.
  "Sacramento Valley, California" or a bbox
- `analysis_types` (array, optional): e.g. `["area", "distance", "overlay"]`
- `web_display_required` (boolean, optional): whether a web map is a deliverable

## Outputs

- `architecture_doc` (string): Markdown doc covering storage CRS, analysis
  CRS, display CRS, and transformation notes
- `recommended_crs` (object): `{storage, analysis, display}` — each an EPSG
  code string with a one-line reason
- `tradeoffs` (array): structured tradeoff entries (`{option, pros, cons}`)

## Tools required

- None. Pure reasoning skill — no MCP or CLI tools.

## Execution plan

1. Validate `project_description` and `area_of_interest` are present; fail
   with a clear error otherwise
2. Resolve `area_of_interest` to candidate zones: UTM zone(s), state plane
   zone(s) where applicable, and note if the AOI spans zone boundaries
3. Map `analysis_types` to CRS properties needed: equal-area for area stats,
   conformal/local for distance, any consistent CRS for overlay
4. Call the workhorse-tier LLM with the system prompt below to draft the doc,
   including a storage/analysis/display split when requirements conflict
5. Extract `recommended_crs` (EPSG codes) and `tradeoffs` from the draft
6. Return doc + structured fields; log run to `dymaxion.skill_invocations`

## LLM prompts

### Draft projection strategy

System: You are a geodesy-literate GIS advisor. You recommend, with
tradeoffs — you never claim certainty. Always give specific EPSG codes.
Distinguish storage CRS, analysis CRS, and display CRS, and say when one CRS
can serve all three. Be blunt about Web Mercator's distortion of area and
distance, and about when it is nonetheless the right display choice. If the
AOI spans multiple UTM or state plane zones, address it explicitly. State
assumptions for missing inputs. No emoji.

User: Project: {project_description}. Area of interest: {area_of_interest}.
Analysis types: {analysis_types}. Web display: {web_display_required}.
Produce a Markdown architecture doc with sections: Recommended CRS strategy
(storage/analysis/display with EPSG codes), Why, Alternatives, Distortion
tradeoffs, Transformation pipeline notes, Assumptions.

## Failure modes

- `area_of_interest` too vague to place ("the west") → fail with a request
  for a bbox, county, or named region resolvable to UTM/state plane zones
- AOI spans multiple UTM/state plane zones → recommend an equal-area or
  national/continental CRS for storage and per-zone CRSs for precise local
  measurement, flagging the tradeoff
- LLM output lacks EPSG codes → retry once demanding explicit codes; else
  return `recommended_crs` with `"undetermined"` entries and the doc intact

## Cost + timeout

- Max cost per invocation: $0.30
- Max duration: 180 seconds
- Typical actual cost: $0.15, typical duration: 25 seconds
