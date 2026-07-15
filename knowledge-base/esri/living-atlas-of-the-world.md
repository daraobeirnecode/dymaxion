---
title: Living Atlas of the World — Categories, Licensing, and Access Patterns
category: esri
topic_tags: [living-atlas, curated-content, imagery, boundaries, demographics, licensing]
status: stub
---

# Living Atlas of the World — Categories, Licensing, and Access Patterns

Covers Esri's curated catalog of authoritative geographic content at livingatlas.arcgis.com. Categories include Imagery (World Imagery, Sentinel-2 and Landsat multispectral imagery layers, NAIP), Basemaps (raster and vector tile), Boundaries and Places (World Administrative Divisions, USA states/counties/tracts/ZIP codes), Demographics and Lifestyle (Esri Updated Demographics, ACS layers, Tapestry), Environment (USA NLCD Land Cover, elevation/terrain services, live weather and NDFD feeds, USA SSURGO soils), Transportation, and historical maps. Licensing tiers matter for automation: most layers are free with any ArcGIS account, "subscriber content" requires signing in with an org account (no credits), and "premium content" (e.g. some GeoEnrichment-backed and traffic layers) consumes credits — the item's `contentStatus`/badging indicates which. Access patterns: browse UI, or programmatically via `GIS("https://www.arcgis.com").content.search(query="...", outside_org=True)` filtered with `group:"Living Atlas"` or the Living Atlas group IDs, then use returned items as `FeatureLayer`/`ImageryLayer` inputs; layers can also be added to Pro from the portal pane with Living Atlas filter enabled. Well-known stable item IDs exist for staples like World Imagery and World Topographic Map and should be pinned in project context rather than re-searched. Notes usage constraints: subscriber/premium layers cannot be publicly reshared in apps without matching end-user licensing, and export/download is disabled on most curated services (use extract-capable layers or source data portals instead).

TODO: expand from authoritative source (livingatlas.arcgis.com and doc.arcgis.com Living Atlas documentation).
