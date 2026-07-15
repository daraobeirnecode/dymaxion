---
title: MapLibre Terrain, 3D, and MapLibre Native
category: oss
topic_tags: [maplibre, terrain, 3d, fill-extrusion, maplibre-native, mobile]
status: stub
---

# MapLibre Terrain, 3D, and MapLibre Native

3D terrain in MapLibre GL JS uses a `raster-dem` source pointing at encoded elevation tiles — `encoding: "terrarium"` for AWS Terrain Tiles (`s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`) or `encoding: "mapbox"` for Mapbox/MapTiler RGB DEMs — activated with `map.setTerrain({source: 'dem', exaggeration: 1.5})` or a `terrain` block in the style. Pair terrain with a `hillshade` layer on the same DEM source for shaded relief, and `sky`/`fog` style properties for horizon rendering; camera `pitch` (up to 85) and `bearing` make it navigable, and `map.queryTerrainElevation(lnglat)` reads elevation at a point. 3D buildings come from `fill-extrusion` layers driven by attributes: `"fill-extrusion-height": ["get", "render_height"]` with `fill-extrusion-base` for floating stories — OpenMapTiles' `building` layer carries these fields. Custom 3D content (models, three.js scenes) mounts through `CustomLayerInterface` with direct WebGL access, and v5 adds globe projection. MapLibre Native is the C++ sibling rendering the same style spec on Android (`org.maplibre.gl:android-sdk`), iOS (`MapLibre` via SPM/CocoaPods), and via community wrappers for React Native (`@maplibre/maplibre-react-native`) and Flutter — one style JSON serves web and mobile, which is the practical payoff. Native builds render with OpenGL ES/Metal, support offline tile packs (MBTiles/PMTiles bundles), and mirror the runtime styling API (style layers, camera, annotations). Divergences to watch: some newer GL JS features (globe, certain expressions) lag in Native, so pin style features to the lowest common renderer when sharing styles across platforms.

TODO: expand from authoritative source (maplibre.org/maplibre-gl-js/docs — terrain examples, and maplibre.org/maplibre-native).
