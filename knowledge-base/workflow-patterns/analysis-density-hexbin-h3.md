---
title: "Analysis: Density Surfaces, Hexbins, and H3"
category: workflow-patterns
topic_tags: [density, kernel-density, hexbin, h3, aggregation, heatmap]
status: stub
---

# Analysis: Density Surfaces, Hexbins, and H3

Three families answer "where is it concentrated": kernel density (continuous raster surface), hexagonal binning (discrete equal-area cells), and hierarchical grids like H3 (indexed cells that double as join keys). Kernel density (`arcpy.sa.KernelDensity`, QGIS Heatmap algorithm, scipy `gaussian_kde`) is bandwidth-sensitive — the search radius drives the story more than the data, so report it, and use an equal-area CRS so units are events/km². Hexbins avoid the KDE smoothing debate: PostGIS 3.1+ generates them natively with `ST_HexagonGrid(size, bounds)` joined via `ST_Intersects` and `count(*) GROUP BY` (with `ST_SquareGrid` as the square alternative); QGIS "Create grid" + "Count points in polygon" is the desktop path. H3 (Uber's hierarchical hex index, resolutions 0–15; res 8 ≈ 0.74 km², res 9 ≈ 0.10 km²) assigns each point a cell id via `h3_lat_lng_to_cell` (h3-pg extension, `h3-py`, or DuckDB's h3 extension), making density a plain `GROUP BY h3_index` — and the same index later joins disparate datasets without spatial predicates. H3 cells are not perfectly equal-area (~±1.6x within a resolution) and hexagons cannot nest exactly (aperture-7 approximation), so for strict statistical normalization prefer a true equal-area grid in EPSG:3310. Normalize counts by population or area before mapping, or the result is a population map; choropleth class breaks (Jenks vs quantile) change the visual story and belong in the run notes. For web delivery, hexbin/H3 aggregates tile well as MVT and are the standard fix for the "500k points crash the browser" problem.

TODO: expand from authoritative source (H3 documentation at h3geo.org; PostGIS ST_HexagonGrid docs; Esri Kernel Density tool reference).
