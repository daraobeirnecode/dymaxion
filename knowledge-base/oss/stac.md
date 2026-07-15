---
title: "STAC: SpatioTemporal Asset Catalog"
category: oss
topic_tags: [stac, satellite-imagery, pystac-client, stackstac, planetary-computer, earth-search]
status: stub
---

# STAC: SpatioTemporal Asset Catalog

STAC standardizes how satellite/aerial data is cataloged as JSON: a Catalog links to Collections (a dataset like "Sentinel-2 L2A" with license, extent, summaries), Collections contain Items (one GeoJSON Feature per scene with `datetime`, `bbox`, `geometry`, and properties like `eo:cloud_cover`), and Items hold Assets (hrefs to the actual files — typically COGs — keyed by band or role such as `thumbnail`, `B04`, `visual`). Static STAC is just linked JSON files on object storage; a STAC API adds `/search` (POST with `collections`, `bbox`, `datetime="2026-06-01/2026-07-01"`, `query`/`filter` on properties, paging) plus `/collections/{id}/items` — it is OGC API Features-compliant. Major public endpoints: Microsoft Planetary Computer (`planetarycomputer.microsoft.com/api/stac/v1`, requires signing asset URLs via `planetary_computer.sign`), Element 84 Earth Search (`earth-search.aws.element84.com/v1`, Sentinel-2/Landsat/NAIP on AWS open data), USGS LandsatLook, and the Copernicus Data Space STAC. Python workflow: `pystac_client.Client.open(url)` then `client.search(collections=["sentinel-2-l2a"], bbox=..., datetime=..., query={"eo:cloud_cover": {"lt": 20}})` yields Items; `stackstac.stack(items, assets=["B04","B08"], resolution=10, epsg=32610)` lazily assembles them into a dask-backed xarray DataArray for NDVI math without downloading whole scenes (odc-stac is the main alternative). Server-side, stac-fastapi + pgstac stores catalogs in Postgres for self-hosted APIs, and stac-browser gives a UI over any catalog. STAC extensions (`eo`, `sar`, `raster`, `proj`, `view`) standardize per-domain metadata — filter on `proj:epsg` or `sar:polarizations` the same way across providers. For Dymaxion, STAC is the discovery layer of every imagery skill: search → sign → read COG ranges via `/vsicurl/` → analyze.

TODO: expand from authoritative source (stacspec.org, pystac-client.readthedocs.io, stackstac.readthedocs.io).
