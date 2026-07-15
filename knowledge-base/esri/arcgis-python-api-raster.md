---
title: arcgis Python API — arcgis.raster for Imagery Workflows
category: esri
topic_tags: [arcgis-python-api, raster, imagery-layer, raster-functions, ndvi, image-server]
status: stub
---

# arcgis Python API — arcgis.raster for Imagery Workflows

Covers server-side imagery analysis with `arcgis.raster`, which drives Image Server / hosted imagery layers over REST rather than local processing. `ImageryLayer(url, gis)` (or `item.layers[0]`) supports `.export_image()`, `.identify()`, `.compute_histograms()`, `.get_samples()`, and lazy raster function chains: `arcgis.raster.functions` provides `ndvi()`, `stretch()`, `remap()`, `colormap()`, `clip()`, `mask()`, and arithmetic (`raster1 - raster2`) that compose into rendering rules evaluated server-side only when exported or persisted with `.save()`. Distributed analysis via `arcgis.raster.analytics` (requires ArcGIS Image Server with Raster Analytics): `generate_raster()`, `convert_feature_to_raster()`, `summarize_raster_within()`, `create_image_collection()`, and `copy_raster()` for publishing local rasters as hosted imagery layers. The `Raster` class and `RasterCollection` (multidimensional/time-series, with `.filter_by_time()`, `.map()`, `.max()` reducers) handle both local (arcpy-backed when available) and remote engines. Also covers `arcgis.raster.orthomapping` for drone imagery blocks and OrthoMaps, and multidimensional support (netCDF-style variables/dimensions, `aggregate_multidimensional_raster`). Notes AGOL user-managed hosted imagery vs Enterprise Image Server deployments, credit/compute costs of raster analytics jobs, and that heavy local raster math is usually better done in the open-source stack (GDAL/rasterio) when no Esri dependency exists.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.raster module reference).
