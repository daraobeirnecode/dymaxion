---
title: arcgis Python API — Geoenrichment for Demographics
category: esri
topic_tags: [arcgis-python-api, geoenrichment, demographics, enrich, study-areas, credits]
status: stub
---

# arcgis Python API — Geoenrichment for Demographics

Covers `arcgis.geoenrichment`, the wrapper over Esri's GeoEnrichment service that appends demographic, spending, and business attributes to locations. The core call is `enrich(study_areas, data_collections=["KeyGlobalFacts"], analysis_variables=["KeyGlobalFacts.TOTPOP"])` where study areas can be points with buffers (`BufferStudyArea(area=pt, radii=[1,3,5], units="Miles")`), drive-time service areas (`travel_mode="Driving"`), polygons/geometries, standard geography levels (block groups, tracts, counties via `NamedArea`), or addresses; results return as a Spatially Enabled DataFrame. Discovery APIs: `Country.get("US")`, `country.data_collections` (a DataFrame of collections like ASCME (spending), KeyUSFacts, tapestry segmentation), `country.subgeographies` for navigating states→counties→tracts, and `create_report()` for PDF/XLSX infographic-style reports against report templates. Explains credit consumption (geoenrichment is one of the most credit-expensive AGOL operations, ~10 credits per 1000 attributes) and why runs must respect Dymaxion's per-skill cost caps. Covers data source vintage (Esri Updated Demographics, ACS, Michael Bauer Research internationally), the underlying REST endpoint (`/arcgis/rest/services/World/GeoenrichmentServer`), and licensing prerequisites (privilege to use GeoEnrichment; Business Analyst shares the same data). Notes results carry `sourceCountry` and apportionment metadata explaining how block-level data was weighted into custom polygons.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.geoenrichment module reference and GeoEnrichment service REST docs).
