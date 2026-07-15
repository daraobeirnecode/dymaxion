---
slug: stac-catalog-search
name: STAC Catalog Search
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# STAC Catalog Search

## Purpose

Search a STAC API catalog (Earth Search, Planetary Computer, or any compliant
endpoint on the allowlist) for imagery items matching a bbox, a date range, and
a cloud-cover ceiling. Returns item ids, asset HREFs, and per-item properties so
downstream skills can fetch or warp the scenes.

## When to use this skill

- "Find Sentinel-2 / Landsat scenes over this area, this period, under N% cloud"
- Sourcing imagery inputs for `gdal-raster-warp` or `gdal-format-convert`
  (COG assets can be warped directly via `/vsicurl/`)
- Checking acquisition coverage/cadence over an AOI before committing to an
  analysis approach

## When NOT to use this skill

- Downloading or processing the imagery itself — this skill returns URLs only
- Searching Esri-hosted imagery — use Category A `living-atlas-search`
- Vector or non-imagery data discovery — STAC here is scoped to
  imagery collections

## Inputs

- `catalog_url` (string, required): STAC API root, e.g.
  `https://earth-search.aws.element84.com/v1`
- `bbox` (array, required): `[west, south, east, north]` in WGS84
- `datetime_range` (string, optional): RFC 3339 interval, e.g.
  `2026-05-01/2026-07-01`; open-ended forms accepted (`2026-05-01/..`)
- `collections` (array, optional): collection ids; searched across all when omitted
- `max_cloud_cover` (number, optional): filter `eo:cloud_cover <= value`

## Outputs

- `items` (array): per item `{id, collection, datetime, cloud_cover, bbox,
  assets: {name: href}}`, sorted by cloud cover ascending
- `search_summary` (object): `{matched, returned, collections_searched,
  date_range_covered, catalog_url}`

## Tools required

- `pystac-client` — STAC API search with pagination

## Execution plan

1. Validate `bbox` (west < east, south < north, within ±180/±90) and the
   datetime interval syntax
2. Open the catalog with pystac-client; confirm it conforms to the STAC API
   `item-search` conformance class
3. If `collections` omitted, list catalog collections and keep imagery-typed
   ones (eo/sar extensions present)
4. Run the search with bbox + datetime + `eo:cloud_cover` filter; paginate up
   to 500 items max
5. Normalize items: keep id, datetime, cloud cover, bbox, and asset HREFs
   (prefer COG/`image/tiff` assets); sort by cloud cover
6. Return items + a summary with concrete match counts

## LLM prompts

### Parse a natural-language imagery request (classification tier)

System: You convert an imagery request into STAC search parameters. Output JSON
only: {"collections": [...], "datetime_range": "start/end",
"max_cloud_cover": n}. Choose collections strictly from the provided list.

User: Available collections: {collections_json}. AOI already resolved. Request:
{user_request}. Today is {today}.

## Failure modes

- Catalog root unreachable or non-conformant → fail with the HTTP status and
  the conformance classes actually advertised; suggest a known-good catalog
- Zero matches → relax automatically in one step (double the cloud ceiling OR
  widen the interval by 1 month, whichever the request hinted was softer),
  rerun once, and report both result counts
- Collection id not in the catalog → return the catalog's real collection ids
  containing the closest substring match; do not search all collections silently
- More than 500 matches → return the 500 lowest-cloud items with
  `search_summary.matched` showing the true total

## Cost + timeout

- Max cost per invocation: $0.05
- Max duration: 60 seconds
- Typical actual cost: $0.02, typical duration: 2-10 seconds
