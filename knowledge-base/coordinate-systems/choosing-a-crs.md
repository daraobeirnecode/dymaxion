---
title: Choosing a CRS per Project
category: coordinate-systems
topic_tags: [crs-selection, srid, project-setup, reprojection, best-practices]
status: stub
---

# Choosing a CRS per Project

CRS choice is a project-inception decision driven by four questions: extent, purpose (measurement vs display vs exchange), required accuracy, and what the client's existing data uses. Defaults that rarely fail: web display → EPSG:3857; data exchange and APIs → EPSG:4326 (GeoJSON requires it per RFC 7946); California statewide statistics → EPSG:3310 (equal-area); Sacramento-region engineering and cadastral → State Plane Zone II EPSG:2226 in US survey feet; regional metric analysis → UTM 10N EPSG:26910. Match the projection property to the analysis: area/density → equal-area (Albers), bearings/shape at large scale → conformal (Lambert/TM), distances from a point → azimuthal equidistant or geodesic functions. Honor the client's CRS for deliverables even if you analyze in another — reproject at the boundary and document the transformation (including the geographic transformation used, e.g. WGS84↔NAD83 grid vs null shift). Record the decision in `dymaxion.projects.context` (working SRID, delivery SRID, vertical datum, transformation path) so every skill run uses the same parameters. Repeated `ST_Transform` in queries is a smell: store analysis-ready copies in the working CRS with a spatial index rather than transforming per query. Beware unit surprises (survey feet vs meters, degrees in geographic CRS) and datum-realization mismatches (NAD83(2011) vs NAD83(HARN)) that are invisible until control points disagree by decimeters.

TODO: expand from authoritative source (Esri "choose the right projection" guidance; PROJ/EPSG registry; project CRS decision checklists from NGS).
