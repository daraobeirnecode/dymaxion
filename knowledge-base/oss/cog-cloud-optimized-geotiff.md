---
title: Cloud Optimized GeoTIFF (COG) Creation
category: oss
topic_tags: [cog, geotiff, gdal, cloud-native, raster, overviews]
status: stub
---

# Cloud Optimized GeoTIFF (COG) Creation

A COG is a regular GeoTIFF whose internal layout — tiled pixels, internal overviews, and header-first IFD ordering — allows efficient HTTP range-request access, so clients read only the tiles and zoom levels they need. Since GDAL 3.1 creation is a dedicated driver: `gdal_translate input.tif output_cog.tif -of COG -co COMPRESS=DEFLATE -co PREDICTOR=YES -co BLOCKSIZE=512 -co OVERVIEWS=IGNORE_EXISTING -co NUM_THREADS=ALL_CPUS`. Compression choices: DEFLATE or ZSTD (lossless, analytic data), JPEG with `-co QUALITY=85` (lossy, RGB imagery), LZW as a safe default, and `-co PREDICTOR=2` for integer / `3` for float data. Add `-co TILING_SCHEME=GoogleMapsCompatible` to align internal tiles with web-map zoom levels, and `-co RESAMPLING=AVERAGE` (or NEAREST for categorical) to control overview generation. Validate with `python -m osgeo_utils.samples.validate_cloud_optimized_geotiff output_cog.tif` or `rio cogeo validate`; the alternative creation tool is `rio cogeo create` from rasterio's rio-cogeo plugin. Serve COGs directly from S3/object storage with no tile server, or dynamically tile them with TiTiler; QGIS, MapLibre (via raster protocols), and rasterio all read them over `/vsicurl/`. Convert in bulk from a VRT mosaic: `gdalbuildvrt mosaic.vrt tiles/*.tif && gdal_translate mosaic.vrt mosaic_cog.tif -of COG`. COG is the de facto raster format in STAC catalogs like Planetary Computer and Earth Search.

TODO: expand from authoritative source (gdal.org/drivers/raster/cog.html and cogeo.org).
