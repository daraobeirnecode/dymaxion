---
title: Vertical Datums and Geoid Models
category: coordinate-systems
topic_tags: [vertical-datum, navd88, geoid, elevation, orthometric, ellipsoidal]
status: stub
---

# Vertical Datums and Geoid Models

GPS delivers ellipsoidal heights (height above the WGS84/GRS80 ellipsoid), while engineering and floodplain work uses orthometric heights (height above the geoid, roughly mean sea level); the difference — the geoid undulation N, where H = h − N — is about −30 m in California. NAVD88 (EPSG:5703) is the current US orthometric datum, replacing NGVD29; the NGVD29→NAVD88 shift varies regionally (roughly +0.7 to +0.8 m in the Sacramento area) and is computed with NOAA's VERTCON grids. Geoid models convert ellipsoidal to orthometric height: GEOID18 is the current NGS hybrid model for NAD83(2011) heights, distributed as grids PROJ can consume (`us_noaa_g2018u0.tif`); older data may reference GEOID12B or GEOID09 and must not be mixed silently. Compound CRSs encode 3D position + vertical datum, e.g. EPSG:6349 (NAD83(2011) + NAVD88 height); lidar deliverables (LAS/LAZ) declare vertical CRS in their header VLRs and are a frequent source of mismatched-datum errors. FEMA flood studies, Delta levee work, and subsidence monitoring in the Central Valley are all NAVD88-based, so elevation joins across datasets must normalize vertical datum first. NOAA's VDatum tool transforms among ellipsoidal, orthometric, and tidal datums (MLLW, MHW) for coastal work. The upcoming NAPGD2022 geopotential datum will replace NAVD88 alongside the NATRF2022 horizontal modernization.

TODO: expand from authoritative source (NOAA NGS GEOID18 and VDatum documentation; PROJ vertical grid documentation).
