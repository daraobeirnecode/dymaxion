---
title: Network Analyst Extension — Routing, Service Areas, and OD Matrices
category: esri
topic_tags: [network-analyst, routing, service-area, closest-facility, od-cost-matrix, network-dataset]
status: stub
---

# Network Analyst Extension — Routing, Service Areas, and OD Matrices

Covers the Network Analyst extension (`arcpy.nax` — the modern module replacing `arcpy.na` — plus ready-to-use online services) for transportation network analysis. Analysis types: Route (optimal stop sequencing with `find_best_sequence`), Service Area (drive-time/distance polygons around facilities, e.g. 5/10/15-minute breaks), Closest Facility (nearest N facilities to incidents), OD Cost Matrix (many-to-many travel-cost table, the input to accessibility and location-allocation work), Location-Allocation (site selection maximizing coverage), and Vehicle Routing Problem (fleets, capacities, time windows). The `arcpy.nax` workflow: build or reference a network dataset (edges/junctions/turns with travel-mode attributes, historical traffic, restrictions like one-way and height limits), then `nax.Route(network)`, `route.load(nax.RouteInputDataType.Stops, ...)`, `result = route.solve()`, `result.export()`. Alternatively, AGOL's World Routing Services (routing.arcgis.com) provide the same solvers without building a network — credit-consuming, accessible via `arcgis.network` module (`RouteLayer.solve`, `generate_service_areas`, `generate_origin_destination_cost_matrix`). Covers travel modes (driving, trucking, walking with impedance `TravelTime` vs `Miles`), time-of-day solving with traffic, and barriers (point/line/polygon). Notes StreetMap Premium as the licensed data option for local network datasets and that OD matrices grow O(origins x destinations) — chunk large problems.

TODO: expand from authoritative source (pro.arcgis.com Network Analyst documentation and arcpy.nax module reference).
