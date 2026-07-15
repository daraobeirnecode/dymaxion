---
title: "Analysis: Isochrones and Service Areas"
category: workflow-patterns
topic_tags: [isochrones, service-area, routing, pgrouting, valhalla, network-analysis]
status: stub
---

# Analysis: Isochrones and Service Areas

An isochrone is the polygon reachable from an origin within a travel-time budget over a network — the correct basis for "coverage" questions (fire response, store catchments, transit access) where Euclidean buffers overstate reach by 30–50% in street grids. Open-source engines: Valhalla's `/isochrone` API (contours by minutes or kilometers, costing models for auto/bicycle/pedestrian), OpenRouteService `v2/isochrones`, GraphHopper, and OSRM (table service plus post-hoc alpha shapes); pgRouting computes it in-database with `pgr_drivingDistance` over an edge table built by osm2pgrouting or osm2po, polygonized with alpha shapes (`pgr_alphaShape`) or `ST_ConcaveHull`. The Esri equivalent is Network Analyst Service Area (`arcpy.na.MakeServiceAreaAnalysisLayer` or the ArcGIS Online ServiceAreas REST service, which bills credits per facility). Key modeling choices that change answers materially: travel mode and time-of-day traffic, from-facility vs to-facility direction (asymmetric one-ways), detailed vs generalized polygon output, and multiple breaks (e.g. 5/10/15 min rings) vs a single contour. Network data quality dominates: OSM completeness for pedestrian links, turn restrictions, and speed assumptions should be validated against a handful of known drive times before trusting outputs. For many-origin batch runs, precompute a cost matrix (`pgr_dijkstraCostMatrix`, Valhalla `sources_to_targets`) rather than generating thousands of polygons. Store results with their parameters (mode, break values, engine + graph date) because isochrones are irreproducible without them.

TODO: expand from authoritative source (Valhalla isochrone API docs; pgRouting pgr_drivingDistance docs; Esri Network Analyst service area documentation).
