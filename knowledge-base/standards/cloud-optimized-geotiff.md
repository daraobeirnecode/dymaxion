---
title: Cloud Optimized GeoTIFF (COG)
category: standards
topic_tags: [cog, geotiff, raster, range-requests, gdal, imagery]
status: stub
---

# Cloud Optimized GeoTIFF (COG)

A Cloud Optimized GeoTIFF is a plain GeoTIFF whose internal layout — tiled organization (typically 512×512 internal tiles), overview pyramids, and a header/IFD block at the front of the file — lets clients read just the needed bytes via HTTP range requests from object storage, no server-side raster service required; it became formal as OGC 21-026. Create one with GDAL's COG driver: `gdal_translate input.tif output.tif -of COG -co COMPRESS=DEFLATE -co OVERVIEWS=AUTO` (compression options include DEFLATE, LZW, ZSTD, JPEG/WEBP for visual imagery, and LERC for elevation with `MAX_Z_ERROR`), and validate with `rio cogeo validate` or GDAL's `python3 -m osgeo_utils.samples.validate_cloud_optimized_geotiff`. Any GDAL-based client reads them remotely through `/vsicurl/` (or `/vsis3/`, `/vsigs/`), meaning QGIS, rasterio, and PostGIS out-db rasters can all open a COG on S3 by URL and fetch only the window and overview level requested. Dynamic tiling servers like TiTiler (FastAPI + rasterio) turn a COG URL into XYZ/WMTS tiles on demand — the standard serverless imagery pattern — while STAC catalogs index COG assets for search. The ecosystem runs on it: Sentinel-2 on AWS, USGS 3DEP-derived products, Maxar open data, and NAIP distributions all publish COGs. Performance depends on layout choices: overview levels down to ~256px, sensible blocksize, and `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR` plus `CPL_VSIL_CURL_ALLOWED_EXTENSIONS` env tuning on the client side cut request counts dramatically. COG replaces "publish an image service" for most read-only imagery: store once in object storage, serve everywhere. Its vector-side siblings are FlatGeobuf and PMTiles, which apply the same range-request philosophy.

TODO: expand from authoritative source (cogeo.org; OGC 21-026 COG spec; GDAL COG driver documentation).
