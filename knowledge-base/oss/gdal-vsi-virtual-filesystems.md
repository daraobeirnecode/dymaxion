---
title: GDAL VSI Virtual Filesystems
category: oss
topic_tags: [gdal, vsi, vsis3, vsicurl, cloud-native, streaming]
status: stub
---

# GDAL VSI Virtual Filesystems

GDAL's VSI layer lets every utility (ogr2ogr, gdal_translate, gdalinfo, gdalwarp) read remote and packed data as if it were a local path — no download step. `/vsicurl/https://example.com/data/scene.tif` streams any HTTP(S) resource with range requests, which is what makes COG and FlatGeobuf partial reads work. `/vsis3/bucket/key.tif` reads S3 (auth via `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, or `AWS_NO_SIGN_REQUEST=YES` for public buckets like Sentinel-2 on AWS); the Azure and GCS equivalents are `/vsiaz/` and `/vsigs/`. `/vsizip/` opens archives in place — `ogrinfo /vsizip/parcels.zip` — and prefixes chain, so `/vsizip//vsicurl/https://host/data.zip/layer.shp` reads a shapefile inside a remote zip; `/vsitar/` and `/vsigzip/` handle tarballs and gzip. `/vsimem/` is an in-memory filesystem useful in PyQGIS/Python pipelines for intermediate outputs without disk I/O; `/vsistdout/` and `/vsistdin/` enable shell pipes. Tuning env vars: `GDAL_HTTP_MAX_RETRY`, `GDAL_HTTP_RETRY_DELAY`, `CPL_VSIL_CURL_ALLOWED_EXTENSIONS`, `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR` (avoids costly directory listings on object stores), and `VSI_CACHE=TRUE` with `VSI_CACHE_SIZE`. Inspect remote files cheaply with `gdalinfo /vsis3/...` before deciding to pull data. This is the core mechanic behind cloud-native ETL: filter and clip server-side ranges instead of copying whole datasets.

TODO: expand from authoritative source (gdal.org/user/virtual_file_systems.html).
