---
slug: feature-layer-publish
name: Feature Layer Publish
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# Feature Layer Publish

## Purpose

Publish a local geodataset — GeoPackage, shapefile, or GeoJSON — as a hosted
Feature Service in an ArcGIS org. Requires operator approval and an explicit
target folder. Small uploads go direct via esri-mcp; large ones are staged
through the Windows Worker and published with arcpy.

## When to use this skill

- User has a local dataset and asks to "publish", "host", or "make a feature
  service from" it
- A pipeline output (e.g. from `gdal-format-convert`) needs to land in the
  org as a service

## When NOT to use this skill

- Editing features on an existing service — use `feature-service-edit`
- Overwriting an existing service — separate operation with its own
  approval; this skill never overwrites
- Serving tiles from PostGIS — use `martin-tile-serve` or
  `geoserver-publish`

## Inputs

- `source_path` (string, required): local path to .gpkg, .shp (+ sidecars),
  or .geojson
- `target_org_url` (string, required): destination ArcGIS org URL
- `target_folder` (string, required): destination folder — mandatory, per
  the library contract; no publishing to root
- `service_name` (string, optional): service name. Default: sanitized source
  filename
- `sharing_level` (string, optional): `private`, `org`, or `public`.
  Default `private`

## Outputs

- `service_url` (string): REST URL of the published Feature Service
- `publish_report` (object): source stats (format, feature count, CRS),
  upload path taken (direct / worker), post-publish verification result,
  sharing applied

## Tools required

- `esri-mcp` — addItem + publish + sharing for direct uploads
- `windows-worker` — arcpy staging path for uploads over 100 MB

## Execution plan

1. Validate `source_path` exists and the format is supported; read schema,
   feature count, and CRS locally
2. Choose the path: under 100 MB → direct esri-mcp addItem + publish;
   otherwise stage to the Windows Worker and publish via arcpy
3. Check the target org for a service-name collision; fail early if taken
4. Workhorse LLM drafts the approval summary: dataset stats, target org and
   folder, service name, requested sharing level
5. Approval gate — publishing to an org is destructive
6. Upload and publish; poll the publish job to completion
7. Verify: query the new service and compare feature count to the source
8. Apply `sharing_level`; return `service_url` + `publish_report`

## LLM prompts

### Approval summary (workhorse tier)

System: You draft pre-approval summaries for publishing GIS data. State:
source file, format, feature count, CRS, target org, target folder, service
name, and requested sharing level. One line each. Flag `public` sharing
explicitly. No adjectives.

User: Source: {source_path} ({format}, {feature_count} features,
{crs}). Target: {target_org_url}, folder {target_folder}, service name
{service_name}, sharing {sharing_level}. Draft the approval summary.

## Failure modes

- Service name collision in the target org — fail listing the existing item
  id and owner; never overwrite without a separately approved operation
- Publish job hangs past the timeout — cancel the job and delete the
  uploaded staging item so no orphan is left in the org
- Source has no CRS (missing .prj / undefined SRS) — fail asking for a
  declared CRS rather than assuming WGS84
- Post-publish feature count mismatch — flag it in `publish_report` and
  leave the service `private` regardless of the requested sharing level

## Cost + timeout

- Max cost per invocation: $0.20 (budget cap)
- Max duration: 300 seconds (excluding operator approval wait)
- Typical actual cost: $0.10, typical duration: 45-180 seconds by file size
