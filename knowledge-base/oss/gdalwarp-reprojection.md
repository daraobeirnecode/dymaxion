---
title: gdalwarp Reprojection and Resampling
category: oss
topic_tags: [gdal, gdalwarp, reprojection, resampling, mosaic, raster]
status: stub
---

# gdalwarp Reprojection and Resampling

`gdalwarp` reprojects, resamples, mosaics, and clips rasters: `gdalwarp -t_srs EPSG:3857 -r bilinear input.tif output_webmerc.tif`. Resampling methods matter: `-r near` (default, correct for categorical data like land cover), `-r bilinear`/`-r cubic` for continuous data (DEMs, imagery), `-r average`/`-r mode` for downsampling, `-r lanczos` for high-quality imagery. Set target resolution with `-tr 30 30` and snap the grid with `-tap` (target-aligned pixels) so multiple outputs align. Clip to a polygon with `-cutline boundary.gpkg -crop_to_cutline -dstnodata 0` (also accepts `-cutline_srs` and cutline SQL/where), or clip to a box with `-te xmin ymin xmax ymax`. Mosaic by listing multiple inputs: `gdalwarp a.tif b.tif c.tif mosaic.tif`, or build a `gdalbuildvrt` VRT first for lazy mosaics of hundreds of tiles. Performance flags: `-multi -wo NUM_THREADS=ALL_CPUS -co NUM_THREADS=ALL_CPUS --config GDAL_CACHEMAX 2048` and `-co TILED=YES -co COMPRESS=DEFLATE` on the output. `-srcnodata`/`-dstnodata` control nodata propagation across the warp, and `-ot Float32` preserves precision when the transform introduces fractional values. Datum-shift accuracy depends on PROJ grid files — install `proj-data` or enable `PROJ_NETWORK=ON` so NAD27→NAD83→WGS84 shifts use NTv2/GTX grids instead of approximate transforms.

TODO: expand from authoritative source (gdal.org/programs/gdalwarp.html).
