---
title: "OpenLayers: Projections and When to Prefer It"
category: oss
topic_tags: [openlayers, projections, wms, proj4js, web-mapping]
status: stub
---

# OpenLayers: Projections and When to Prefer It

OpenLayers is the most capable browser mapping library for OGC services and non-Web-Mercator work: prefer it over MapLibre when you need first-class WMS/WMTS/WFS clients (`ol/source/TileWMS`, `ImageWMS`, `WMTS` with capabilities parsing, `ol/format/WFS`), rendering in arbitrary projections, advanced vector editing, or map printing at scale. The core objects: `new Map({target, layers, view})`, `new View({center, zoom, projection})`, layer classes (`Tile`, `Image`, `Vector`, `VectorTile`, `WebGLPoints`) each wrapping a `source`, and `ol/format` parsers (GeoJSON, GML, KML, MVT, WKT). Projections beyond EPSG:3857/4326 register through proj4js: `proj4.defs('EPSG:26910', '+proj=utm +zone=10 +datum=NAD83 +units=m +no_defs'); register(proj4);` after which a `View` can operate natively in UTM, State Plane, or polar projections — MapLibre GL fundamentally renders only Web Mercator (plus globe), so reprojection-faithful government/scientific viewers are OL territory. OL also reprojects raster sources client-side between registered CRSs, letting a state-plane WMTS underlay a WGS84 overlay. Vector interaction is built in: `ol/interaction/Draw`, `Modify`, `Snap`, and `Select` cover full editing workflows without plugins, wired to WFS-T for transactional saves. Rendering is Canvas 2D by default (predictable labels, crisp printing) with WebGL layers for large point sets — generally slower than MapLibre's pure-WebGL pipeline for big vector-tile basemaps, which is the main reason MapLibre wins for consumer-style slippy maps. Styling is imperative JS (`ol/style/Style` with functions per feature/resolution) rather than a declarative spec, and can express flat style objects since v7+. Rule of thumb: MapLibre for vector-tile basemaps and mobile-smooth UX; OpenLayers for OGC-heavy, projection-exotic, or edit-intensive applications.

TODO: expand from authoritative source (openlayers.org/doc and openlayers.org/en/latest/apidoc).
