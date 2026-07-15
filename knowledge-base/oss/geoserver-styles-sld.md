---
title: GeoServer Styles and SLD
category: oss
topic_tags: [geoserver, sld, styling, cartography, css, ysld]
status: stub
---

# GeoServer Styles and SLD

GeoServer's native styling language is SLD (Styled Layer Descriptor), an OGC XML format: a `StyledLayerDescriptor` contains `FeatureTypeStyle` > `Rule` > symbolizers (`PointSymbolizer`, `LineSymbolizer`, `PolygonSymbolizer`, `TextSymbolizer`, `RasterSymbolizer`). Rules combine OGC Filter predicates (`PropertyIsEqualTo`, `PropertyIsBetween`) with `MinScaleDenominator`/`MaxScaleDenominator` for scale-dependent rendering — the mechanism behind class-based choropleths and zoom-dependent labeling. Fills, strokes, and labels take CSS-like parameters (`<CssParameter name="fill">#2b8cbe</CssParameter>`, `stroke-width`, `font-family`) and support attribute-driven values via `<ogc:PropertyName>`. GeoServer extensions ease authoring: the CSS extension (`geoserver-css`) and YSLD offer terser syntax that compiles to SLD, and GeoStyler or QGIS's SLD export can generate SLD from other formats (QGIS export is imperfect — expect manual fixes on labels and expressions). Styles are managed as first-class REST resources (`POST /rest/styles` with `application/vnd.ogc.sld+xml`), assigned per layer as default or alternate, and selectable per request with the WMS `STYLES=` parameter or overridden entirely via `SLD_BODY=`. `RasterSymbolizer` handles DEM/imagery with `ColorMap` entries (ramp, intervals, values types) and `ChannelSelection` for band composites. Label conflict resolution, halos, and `VendorOption` settings (e.g. `labelObstacle`, `maxDisplacement`, `group`) are GeoServer-specific but essential for readable maps. For MVT/vector-tile output styling shifts client-side (MapLibre style JSON) — SLD only governs server-rendered WMS/WMTS imagery.

TODO: expand from authoritative source (docs.geoserver.org — Styling section, and OGC SLD 1.1 spec).
