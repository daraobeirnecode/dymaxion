---
title: "Tile Strategy: Pre-Baked vs Dynamic, MVT vs Raster vs 3D"
category: architecture
topic_tags: [tiles, mvt, raster-tiles, 3d-tiles, tippecanoe, tile-server]
status: stub
---

# Tile Strategy: Pre-Baked vs Dynamic, MVT vs Raster vs 3D

Pre-baked tiles (tippecanoe/planetiler → MBTiles/PMTiles artifacts, or seeded GeoWebCache/Esri caches) trade build time and storage for zero-render serving and total predictability; dynamic tiles (pg_tileserv, Martin, TiTiler, GeoServer, `ST_AsMVT` straight from PostGIS) trade per-request compute for always-current data and no build pipeline. Choose by change cadence: data updated monthly → pre-bake; updated continuously with users who must see edits → dynamic (or dynamic + short-TTL CDN); nightly-updated county layers sit in the middle and usually get dynamic serving with cache headers matched to the load window. Format-wise, Mapbox Vector Tiles (MVT, protobuf per the Mapbox VT spec 2.1) are the modern default for feature data: 5–10x smaller than raster equivalents, client-side styling and interaction (MapLibre, deck.gl, Esri vector basemaps), typically built to z14 with overzoom beyond. Raster tiles (PNG/JPEG/WebP 256px) remain right for imagery, hillshade, scientific rasters, and clients that cannot run WebGL; server-side-rendered raster cartography survives mainly for pixel-exact legacy styles. 3D content uses OGC 3D Tiles (Cesium lineage — b3dm/i3dm now consolidating on glTF content) or Esri's I3S/SLPK scene layers; choose by client (CesiumJS/ArcGIS both now read 3D Tiles 1.1) and produce via pg2b3dm, FME, or ArcGIS Pro scene layer packages. Generalization strategy decides vector tile quality: per-zoom simplification, attribute thinning, and tippecanoe's `--drop-densest-as-needed`/`--coalesce-smallest-as-needed` control tile size — keep tiles under ~500 KB or clients stutter. Dynamic MVT from PostGIS is one SQL pattern (`ST_AsMVT(ST_AsMVTGeom(geom, ST_TileEnvelope(z,x,y)))`), which makes "dynamic first, bake when stable" a cheap evolution path. Hybrid is normal: pre-baked basemap + dynamic operational overlay is the dominant production architecture.

TODO: expand from authoritative source (Mapbox Vector Tile spec 2.1; tippecanoe/planetiler docs; OGC 3D Tiles 1.1 spec; pg_tileserv/Martin docs).
