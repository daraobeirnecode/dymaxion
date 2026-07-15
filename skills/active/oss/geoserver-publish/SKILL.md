---
slug: geoserver-publish
name: GeoServer Publish
version: 0.1.0
skill_class: workhorse
authored_by: dymaxion-core-library
---

# GeoServer Publish

## Purpose

Publish a PostGIS table or a GeoPackage file as an OGC WMS/WFS layer through
the GeoServer REST API: create/reuse the store, register the feature type,
attach a style, and verify the layer answers GetCapabilities and a sample
GetMap/GetFeature. Destructive (service publish) — always behind approval.

## When to use this skill

- Exposing an existing PostGIS table as WMS/WFS for desktop or web clients
- Publishing a delivered GeoPackage without loading it into Postgres first
- Re-publishing after a schema change (feature type reload)

## When NOT to use this skill

- Vector tiles (MVT) for a web map — use `martin-tile-serve`; GeoServer WMS is
  the wrong tool for slippy-map vector rendering at scale
- The data is not yet in PostGIS/GeoPackage — convert with
  `gdal-format-convert` first
- Publishing to an ArcGIS org — Category A `feature-layer-publish`

## Inputs

- `geoserver_url` (string, required): base URL, e.g. `http://geoserver:8080/geoserver`
- `workspace` (string, required): target GeoServer workspace (created if absent,
  with approval)
- `source` (object, required): either `{type: "postgis", connection, table}` or
  `{type: "geopackage", path, layer}`
- `layer_name` (string, optional): published name; defaults to the table/layer name
- `style` (string, optional): existing GeoServer style name to set as default

## Outputs

- `layer_urls` (object): `{wms_capabilities, wfs_capabilities, wms_getmap_sample,
  layer_preview}`
- `publish_log` (string): each REST call made, status code, and result

## Tools required

- `http` — GeoServer REST API (credentials from SOPS-encrypted env, never inline)

## Execution plan

1. GET `/rest/about/version` to confirm reachability and API compatibility
2. Check whether workspace, store, and layer already exist; an existing layer
   makes this an overwrite → escalate in the approval text
3. Raise approval request: workspace, store, layer name, source, style, and
   whether anything is overwritten
4. Create (or reuse) the datastore: PostGIS connection params or uploaded
   GeoPackage (`PUT .../file.gpkg`)
5. POST the feature type; set SRS from the source geometry column; enable the
   layer; attach `style` as default if given (verify the style exists first)
6. Verify: GetCapabilities lists the layer; issue a small GetMap (WMS) and
   `GetFeature&count=1` (WFS); both must return 200 with non-error bodies
7. Return `layer_urls` + full `publish_log`

## LLM prompts

### Draft feature type configuration (workhorse tier)

System: You produce a GeoServer REST featureType JSON body. Use the provided
table schema for name, nativeName, srs, and bounding box. Do not invent
attributes. Output JSON only.

User: Workspace: {workspace}. Store: {store}. Table schema: {schema_json}.
Declared SRID: {srid}. Layer name: {layer_name}.

## Failure modes

- GeoServer unreachable or 401 → fail before approval with the HTTP status;
  point at the credentials entry and container health check
- Layer already exists and approval did not cover overwrite → abort with no
  changes; re-request approval explicitly mentioning the overwrite
- Feature type created but GetMap verification fails (empty bbox, SRID 0) →
  roll back by deleting the just-created feature type, report the bbox/SRID
  problem, suggest fixing the geometry column metadata first
- Style not found → publish without it, note in `publish_log`, and list the
  available styles in the workspace

## Cost + timeout

- Max cost per invocation: $0.10
- Max duration: 300 seconds
- Typical actual cost: $0.05, typical duration: 10-40 seconds
