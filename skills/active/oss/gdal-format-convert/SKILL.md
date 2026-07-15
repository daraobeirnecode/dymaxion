---
slug: gdal-format-convert
name: GDAL Format Convert
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# GDAL Format Convert

## Purpose

Convert a spatial dataset between formats using `ogr2ogr` (vector) or
`gdal_translate` (raster): Shapefile ↔ GeoPackage ↔ GeoJSON ↔ FlatGeobuf ↔
GeoParquet, GeoTIFF ↔ COG ↔ PNG, and everything else the local GDAL build
supports. Detects vector vs raster automatically from the input.

## When to use this skill

- "Convert X to GeoPackage/GeoJSON/GeoParquet/COG" style requests
- Normalizing inputs before another skill (e.g. shapefile → GPKG before
  `qgis-algorithm-runner`, table → PG before `geoserver-publish`)
- Applying simple conversion-time options: `-nlt` geometry promotion, layer
  selection, `-select` column subsetting, COG creation options

## When NOT to use this skill

- Raster reprojection/resampling — use `gdal-raster-warp` (gdalwarp semantics)
- Heavy transformation logic (joins, aggregations) — use
  `duckdb-spatial-analytics`
- The output would overwrite a user file that already exists — needs an
  approval flow this read-only skill does not carry; pick a new output path

## Inputs

- `input_path` (string, required): source dataset (file, VRT, or vsicurl URL on
  the employer-boundary allowlist)
- `output_path` (string, required): destination file path
- `output_format` (string, optional): GDAL driver name (`GPKG`, `Parquet`,
  `COG`, ...); inferred from the output extension when omitted
- `options` (array, optional): extra CLI flags passed through verbatim after
  validation (e.g. `["-nlt", "MULTIPOLYGON", "-select", "apn,zone"]`)

## Outputs

- `output_path` (string): path of the converted dataset
- `conversion_summary` (object): `{driver, layer_or_band_count, feature_count,
  crs, size_bytes, duration_ms}`

## Tools required

- `gdal-bin` — ogr2ogr, gdal_translate, ogrinfo, gdalinfo

## Execution plan

1. Run `gdalinfo`/`ogrinfo` on the input to classify raster vs vector and read
   layer/band, CRS, and count metadata
2. Resolve the output driver from `output_format` or the output extension;
   verify the local GDAL build lists it in `--formats`
3. Validate `options` against a flag allowlist (no `-sql` with write clauses,
   no shell metacharacters); refuse to proceed if `output_path` already exists
4. Execute `ogr2ogr -f <driver> <out> <in> <options>` or
   `gdal_translate -of <driver> <in> <out> <options>`
5. Verify the output opens and feature/band counts match the input (within
   expected changes, e.g. geometry promotion keeps count equal)
6. Return summary with concrete counts

## LLM prompts

### Choose driver + flags from a fuzzy request (classification tier)

System: You select a GDAL conversion command. Output JSON only:
{"tool": "ogr2ogr"|"gdal_translate", "output_format": <driver>, "options":
[<flags>]}. Use only drivers from the provided list. Prefer lossless defaults.

User: Input metadata: {gdalinfo_json}. Available drivers: {driver_list}.
Request: {user_request}.

## Failure modes

- Driver missing from the local GDAL build → list the installed drivers for the
  same family (e.g. no `Parquet` → suggest `FlatGeobuf`) and fail cleanly
- Mixed geometry types break a strict output format (e.g. Shapefile) → retry
  once with `-nlt PROMOTE_TO_MULTI` and record the promotion in the summary
- Output feature count differs from input unexpectedly → keep the output but
  mark `conversion_summary.count_mismatch: true` with both numbers
- Input unreadable/corrupt → return the ogrinfo/gdalinfo stderr verbatim; do
  not create a zero-byte output file

## Cost + timeout

- Max cost per invocation: $0.05
- Max duration: 60 seconds
- Typical actual cost: $0.01, typical duration: 1-15 seconds
