---
slug: gdal-raster-warp
name: GDAL Raster Warp
version: 0.1.0
skill_class: classification
authored_by: dymaxion-core-library
---

# GDAL Raster Warp

## Purpose

Reproject and/or resample a raster with `gdalwarp`: target SRS, target
resolution, and resampling kernel are explicit inputs. Produces a tiled,
compressed GeoTIFF (or COG) and reports the before/after grid so the caller can
verify nothing was silently degraded.

## When to use this skill

- Reprojecting a raster to a working CRS (e.g. WGS84 DEM → EPSG:2157 at 10 m)
- Resampling to a coarser/finer grid before analysis or tiling
- Aligning several rasters onto a common grid (`-tr` + `-tap`) ahead of raster
  math in `qgis-algorithm-runner` or `duckdb-spatial-analytics`

## When NOT to use this skill

- Pure format change with no grid change — use `gdal-format-convert`
- Vector reprojection — `gdal-format-convert` with `-t_srs` via ogr2ogr
- Mosaicking hundreds of tiles or continental-scale warps — too large for the
  60 s budget; build a VRT first and warp in chunks, or route to a batch pipeline

## Inputs

- `input_path` (string, required): source raster (GeoTIFF, VRT, COG, ...)
- `output_path` (string, required): destination raster path
- `target_srs` (string, required): EPSG code or PROJ/WKT string, e.g. `EPSG:2157`
- `resolution` (number, optional): target pixel size in target-SRS units; source
  resolution reprojected when omitted
- `resampling` (string, optional, default `bilinear` for continuous /
  `near` for categorical): one of near, bilinear, cubic, cubicspline, lanczos,
  average, mode

## Outputs

- `output_path` (string): path of the warped raster
- `warp_summary` (object): `{src_srs, dst_srs, src_res, dst_res, resampling,
  size_px, nodata, compression, duration_ms}`

## Tools required

- `gdal-bin` — gdalwarp, gdalinfo

## Execution plan

1. `gdalinfo -json` on the input: capture SRS, resolution, size, band types,
   nodata, and whether bands look categorical (Byte + color table)
2. Validate `target_srs` with `gdalsrsinfo`; fail early on unknown codes
3. Pick the resampling default from band type if not supplied (categorical →
   `near`, continuous → `bilinear`); never default categorical data to bilinear
4. Run `gdalwarp -t_srs <srs> [-tr r r -tap] -r <resampling> -multi
   -co TILED=YES -co COMPRESS=DEFLATE -dstnodata <nodata>` to the output path
   (refuse if the output already exists)
5. `gdalinfo` the output; compare extent/resolution/nodata against expectations
6. Return `warp_summary` with the before/after grid

## LLM prompts

### Pick warp parameters from a fuzzy request (classification tier)

System: You configure gdalwarp. Output JSON only: {"target_srs": ...,
"resolution": <number|null>, "resampling": ...}. Categorical rasters (color
table, class codes) must use "near". Choose resolution in target-SRS units.

User: Raster metadata: {gdalinfo_json}. Request: {user_request}.

## Failure modes

- Unknown/invalid `target_srs` → fail before warping with the gdalsrsinfo
  error and 2-3 likely EPSG candidates for the region
- Categorical raster requested with bilinear/cubic → override to `near`, apply,
  and record the override in `warp_summary` (silent class-mixing is worse)
- Output extent is empty (source outside target-SRS validity area) → fail with
  both bounding boxes printed; suggest a suitable local CRS
- Disk-full or OOM on very large rasters → clean up the partial output file,
  report input size, recommend chunked warping via VRT

## Cost + timeout

- Max cost per invocation: $0.05
- Max duration: 60 seconds
- Typical actual cost: $0.01, typical duration: 2-30 seconds
