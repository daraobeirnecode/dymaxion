---
title: arcgis Python API — FeatureLayer Query and Editing
category: esri
topic_tags: [arcgis-python-api, featurelayer, query, edit-features, featureset, sedf]
status: stub
---

# arcgis Python API — FeatureLayer Query and Editing

Covers `arcgis.features.FeatureLayer` and `FeatureLayerCollection`, the Pythonic wrappers over feature service REST endpoints. Construction: `FeatureLayer(url)` directly from a `/FeatureServer/0` URL, or `item.layers[0]` from an `Item`; `FeatureLayerCollection.fromitem(item)` exposes service-level operations. Querying: `layer.query(where="POP2020 > 5000", out_fields="NAME,POP2020", geometry_filter=intersects(polygon), return_geometry=True, as_df=True)` returns a `FeatureSet` or a Spatially Enabled DataFrame (SEDF, the pandas accessor `df.spatial` with `.to_featureclass()`, `.to_featurelayer()`, `.plot()`); the API auto-pages past maxRecordCount. Editing (destructive — approval-gated for Dymaxion): `layer.edit_features(adds=[...], updates=[...], deletes="1,2,3")` maps to applyEdits; check the returned `addResults`/`updateResults` success flags. Service management: `flc.manager.overwrite(local_file)` republishes hosted layers in place, `flc.manager.truncate()`, `layer.append()` for bulk upsert from uploaded items, and `layer.calculate(where, calc_expression)` for server-side field calculation. Also covers `layer.attachments`, `layer.query_related_records()`, `GeoAccessor.from_featureclass()` for local data, and sync/replica APIs under `flc.replicas`. Notes that `query(return_count_only=True)` and `layer.estimates` are the cheap ways to size a layer.

TODO: expand from authoritative source (developers.arcgis.com/python arcgis.features module reference).
