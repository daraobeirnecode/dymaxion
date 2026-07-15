---
title: Turf.js Client-Side Spatial Analysis
category: oss
topic_tags: [turfjs, geojson, client-side, spatial-analysis, javascript]
status: stub
---

# Turf.js Client-Side Spatial Analysis

Turf.js is a modular JavaScript geospatial library operating purely on GeoJSON — no server round-trip — with functions imported individually (`import buffer from '@turf/buffer'`) or via the `@turf/turf` bundle. Geometry operations: `buffer(feature, 500, {units: 'meters'})`, `union`, `intersect`, `difference` (booleanOps run on polygon-clipping), `simplify`, `convex`, `dissolve`, and `bbox`/`bboxPolygon`. Measurement: `area` (m²), `distance` and `length` (haversine, unit-configurable), `along`, `nearestPoint`, `nearestPointOnLine`, `pointToLineDistance`, and `center`/`centroid`/`centerOfMass`. Predicates mirror DE-9IM basics: `booleanPointInPolygon`, `booleanIntersects`, `booleanContains`, `booleanWithin`. Data-shaping helpers make it the glue for map UIs: `featureCollection`/`point`/`polygon` constructors, `featureEach`/`propEach` iterators, `tag` (spatial join copying polygon attributes onto points), `collect` (aggregate point values into polygons), and grid generators `hexGrid`/`squareGrid`/`pointGrid` plus `interpolate` and `isobands`/`isolines` for quick surfaces. Typical pattern: user draws a polygon (Terra Draw/mapbox-gl-draw), Turf buffers it and runs `booleanPointInPolygon` over a few thousand loaded features, and MapLibre re-renders — instant feedback with zero backend. Know its limits: computations are planar on WGS84 coordinates (distances/areas use spherical helpers, but overlays can misbehave near poles/antimeridian), everything runs on the main thread (use a Web Worker beyond ~10⁴–10⁵ features), and precision differs from GEOS/PostGIS. Rule of thumb: Turf for small interactive datasets and instant UX; PostGIS/DuckDB server-side for large data, exact topology, or anything auditable.

TODO: expand from authoritative source (turfjs.org — API documentation).
