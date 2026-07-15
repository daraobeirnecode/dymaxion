---
title: gdal_translate Raster Conversion
category: oss
topic_tags: [gdal, gdal-translate, raster, geotiff, format-conversion]
status: stub
---

# gdal_translate Raster Conversion

`gdal_translate` converts rasters between formats and subsets/rescales them without reprojection (that is `gdalwarp`'s job). Basic form: `gdal_translate -of GTiff input.img output.tif`; the `-of` driver list includes GTiff, COG, PNG, JPEG, HFA, VRT, NetCDF, and XYZ. Subsetting: `-projwin ulx uly lrx lry` clips by georeferenced window, `-srcwin xoff yoff xsize ysize` by pixel window, `-b 4 -b 3 -b 2` selects/reorders bands (e.g., false-color composites from Landsat/Sentinel). Resolution and type: `-outsize 50% 50%` or `-tr xres yres` resamples (with `-r bilinear|cubic|average`), `-ot Byte|UInt16|Float32` changes data type, and `-scale src_min src_max dst_min dst_max` rescales values (essential when converting Float32 reflectance to Byte for web display). Compression and tiling for GeoTIFF: `-co COMPRESS=DEFLATE -co PREDICTOR=2 -co TILED=YES -co BLOCKXSIZE=512 -co BLOCKYSIZE=512`; use `COMPRESS=JPEG -co PHOTOMETRIC=YCBCR` for imagery. `-a_srs EPSG:26910`, `-a_ullr`, and `-a_nodata 0` assign georeferencing metadata without touching pixels. Output to `-of VRT` creates a lightweight XML wrapper for chaining operations lazily. Works on any VSI path, so `gdal_translate /vsicurl/https://.../scene.tif clip.tif -projwin ...` clips remote COGs while downloading only the needed ranges.

TODO: expand from authoritative source (gdal.org/programs/gdal_translate.html).
