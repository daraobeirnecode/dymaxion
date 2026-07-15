---
slug: feature-service-query
name: Feature Service Query
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# Feature Service Query

## Purpose

Run an attribute and/or spatial query against a single layer of an ArcGIS
Feature Service and return the matching features as a GeoJSON
FeatureCollection, plus a one-line summary citing count and source.

## When to use this skill

- User asks "how many features match X" or "which parcels/permits/assets have Y"
  against a known Feature Service
- Another skill (parcel-brief, permit-monitor, dashboard-scaffold) needs raw
  feature data as an intermediate step
- User supplies a where clause, a bounding geometry, or both

## When NOT to use this skill

- User wants field names, types, or domains — use `feature-service-schema-inspect`
- User wants to change data — use `feature-service-edit`
- User is looking for a dataset, not querying one — use `living-atlas-search`
- Bulk export of more than ~10,000 features — needs a paginated extract skill,
  not an interactive query

## Inputs

- `service_url` (string, required): Feature Service root URL, e.g.
  `https://services3.arcgis.com/.../Parcels/FeatureServer`
- `layer_id` (number, required): layer index within the service (0-based)
- `where` (string, optional): SQL-92 where clause. Default `1=1`
- `geometry` (object, optional): GeoJSON geometry used as a spatial filter
  (intersects)
- `out_fields` (array, optional): field names to return. Default all fields

## Outputs

- `features` (object): GeoJSON FeatureCollection of matching features
- `query_summary` (string): one line, e.g. "47 features matched
  ZONING = 'R-1' on layer 0 of .../Parcels/FeatureServer (queried 2026-07-14)"

## Tools required

- `esri-mcp` — Feature Service `query` operation

## Execution plan

1. Check `service_url` host against the allowlist in
   `config/employer-boundary.yaml`; refuse if not listed
2. Normalize the where clause (default `1=1`); reject obvious injection
   patterns (`;`, comment tokens)
3. If `geometry` is provided, convert GeoJSON to Esri JSON and set
   `spatialRel=esriSpatialRelIntersects`, reprojecting to the layer's spatial
   reference if needed
4. Call the esri-mcp query operation with `resultRecordCount` paging
   (2000 per page); follow `exceededTransferLimit` until exhausted or 10 pages
5. Convert the Esri JSON result set to a GeoJSON FeatureCollection
6. One classification-tier LLM call to write `query_summary`
7. Return `features` + `query_summary`

## LLM prompts

### Query summary (classification tier)

System: You are a terse GIS query narrator. Reply with exactly one sentence.
Use concrete numbers, cite the service URL, layer id, and query date. No
adjectives.

User: A query returned {count} features from layer {layer_id} of
{service_url} with where="{where}"{spatial_filter_note} on {date}. Write the
one-line summary.

## Failure modes

- Service unreachable or HTTP 503 — wait 15s, retry once, then fail with the
  portal status URL in the error message
- Server rejects the where clause (400) — do not retry; return the server's
  error message verbatim so the caller can fix the clause
- Paging exceeds 10 pages (`exceededTransferLimit` still true) — stop, return
  the partial FeatureCollection and note the truncation in `query_summary`
- Geometry filter in a different CRS than the layer — read the layer's
  spatial reference from metadata, reproject the filter, retry once

## Cost + timeout

- Max cost per invocation: $0.05 (budget cap)
- Max duration: 60 seconds
- Typical actual cost: $0.01, typical duration: 5 seconds
