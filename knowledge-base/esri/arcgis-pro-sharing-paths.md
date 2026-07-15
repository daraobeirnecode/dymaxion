---
title: Sharing Paths from ArcGIS Pro — Web Maps, Feature Layers, Tile Layers
category: esri
topic_tags: [sharing, publishing, web-layer, feature-layer, tile-layer, vector-tiles]
status: stub
---

# Sharing Paths from ArcGIS Pro — Web Maps, Feature Layers, Tile Layers

Maps out how content moves from ArcGIS Pro to a portal and which layer type to choose. Share > Web Layer offers: feature layers (editable vector features, hosted in the Data Store or referenced from an enterprise geodatabase), tile layers (pre-rendered raster cache, best for static basemap-style content), vector tile layers (compact, restyleable, generated from a map with a supported projection), map image layers (Enterprise-only dynamic rendering from server data), and scene layers (3D: points, 3D objects, integrated mesh, point cloud). Web maps and web scenes are JSON specifications that reference these layers and are shared via Share > Web Map/Web Scene. Explains hosted vs referenced publishing — copy data to the portal's data store versus registering the source database so services read live data — and the overwrite workflow that preserves the item ID and downstream web maps. Programmatic publishing goes through `arcpy.sharing.CreateSharingDraft()` producing an .sddraft, then `arcpy.server.StageService` (.sd) and `arcpy.server.UploadServiceDefinition`, or via the arcgis Python API's `gis.content.add()` + `item.publish()`. Covers analyzers (errors like 00230 layer data source not supported), sharing levels (owner, organization, everyone, groups), and offline-enabled (sync) settings needed for Field Maps. Notes production publishing is gated by approval under Dymaxion's rules.

TODO: expand from authoritative source (pro.arcgis.com "Share web layers" documentation and arcpy.sharing module reference).
