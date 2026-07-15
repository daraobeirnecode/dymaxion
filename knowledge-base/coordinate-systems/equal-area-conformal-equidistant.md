---
title: Equal-Area vs Conformal vs Equidistant Projections
category: coordinate-systems
topic_tags: [projections, equal-area, conformal, equidistant, albers, lambert]
status: stub
---

# Equal-Area vs Conformal vs Equidistant Projections

Every map projection distorts; the choice is which property to preserve, per Tissot's indicatrix analysis. Equal-area (equivalent) projections — Albers Equal Area Conic (used by EPSG:3310 California Albers and EPSG:5070 CONUS Albers), Mollweide, Equal Earth (EPSG:8857) — preserve area and are mandatory for density mapping, choropleths normalized by area, and land-cover statistics. Conformal projections — Lambert Conformal Conic (basis of most State Plane zones like EPSG:2226/2227), Transverse Mercator (UTM), Mercator — preserve local angles and shapes, which suits navigation, cadastral work, and large-scale engineering drawings where bearings must be true. Equidistant projections — Azimuthal Equidistant (EPSG:54032-style), Equidistant Conic — preserve distance only along specific lines or from specific points, useful for range rings and radio-propagation maps. No projection is both equal-area and conformal; compromise projections (Robinson, Winkel Tripel, Natural Earth) sacrifice both for balanced world maps. Practical selection: statewide statistics in California → Albers 3310; county engineering → State Plane conformal zone; distance-from-facility analysis → azimuthal equidistant centered on the facility, or skip projection entirely and use geodesic measurement. In PROJ these correspond to `+proj=aea`, `+proj=lcc`, `+proj=tmerc`, and `+proj=aeqd` cores.

TODO: expand from authoritative source (Snyder, "Map Projections: A Working Manual", USGS Professional Paper 1395; proj.org projections list).
