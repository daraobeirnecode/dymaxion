---
title: "Field Mapping: Offline-First Sync and GPS Accuracy"
category: workflow-patterns
topic_tags: [field-maps, offline, sync, replicas, gps-accuracy, gnss]
status: stub
---

# Field Mapping: Offline-First Sync and GPS Accuracy

Offline-first field collection assumes no connectivity during capture: crews take a map area (basemap tiles + editable layers) to the device, edit locally, and sync deltas when back on network. In the Esri stack this is ArcGIS Field Maps over sync-enabled hosted feature layers — sync uses the REST `createReplica`/`synchronizeReplica` model, requires GlobalIDs, and per-replica server generation numbers track what each device has seen; open-source equivalents are QField/Mergin Maps (QGIS projects with geopackage deltas) and ODK/KoboToolbox for form-centric capture. Conflict policy must be chosen up front: last-writer-wins per feature is the platform default, so partition work areas by crew or use assignment workflows to make true conflicts structurally rare, and review the sync error log (`replicaLog`) after every campaign. Offline basemaps ship as tile packages (`.tpkx`/`.vtpk`) or MBTiles/PMTiles sized to the work area, prepared before mobilization. On accuracy: consumer phone GNSS is 3–5 m horizontal in open sky and far worse under canopy; external receivers (Trimble R-series, Eos Arrow, Bad Elf) with SBAS/RTK corrections reach sub-meter to centimeter, and Field Maps records metadata fields (`ESRIGNSS_HORIZONTALACCURACY`, fix type, PDOP, station count) when GNSS metadata is enabled on the layer. Enforce a capture policy in the app: required accuracy threshold (e.g. reject fixes worse than 5 m), averaging for static points (30+ epochs), and post-processing only when the receiver logs raw observations. Distinguish raw vs averaged vs post-processed coordinates in schema (an `accuracy_m` and `collection_method` field) so downstream analysis can filter by positional quality. Always test the full round trip — take area offline, edit, airplane-mode sync — before the crew leaves, and version the map/project so mid-campaign schema changes don't strand devices.

TODO: expand from authoritative source (ArcGIS Field Maps offline and GNSS docs; ArcGIS REST sync/replica documentation; QField/Mergin Maps sync docs).
