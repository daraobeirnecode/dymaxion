# Dymaxion Knowledge Base

Seed reference material embedded into Dymaxion's memory at startup so the
agent knows the GIS landscape from day one. Sprint 1 ships ~115 stub docs
(headline + 5-10 sentence summary + `TODO: expand from authoritative
source`); Sprint 3 replaces stubs with real chunked content.

## Layout

| Folder | Docs | Coverage |
| --- | --- | --- |
| `esri/` | 30 | platform, REST API, Pro concepts, arcpy, arcgis Python API, Living Atlas, extensions |
| `oss/` | 40 | PostGIS, pgvector, GDAL/OGR, QGIS, GeoServer, tiles, MapLibre/OL/Leaflet/Deck.gl/Cesium/Turf, Sedona, DuckDB, STAC, OSM |
| `coordinate-systems/` | 10 | EPSG, datums, projections, vertical datums, California CRS |
| `workflow-patterns/` | 15 | ETL, publication, analysis, field mapping, enterprise gdb |
| `architecture/` | 10 | deployment, database choice, tile strategy, projection strategy |
| `standards/` | 10 | OGC classic + OGC API, GeoJSON, WKT/WKB, COG/PMTiles/GeoParquet, community |

## Doc format

```markdown
---
title: Human Title
category: <folder name>
topic_tags: [three, to, six, lowercase, tags]
status: stub          # becomes 'expanded' when replaced with real content
---

# Human Title

5-10 substantive sentences...

TODO: expand from authoritative source (<source>).
```

## Loading

`scripts/load-knowledge-base.sh` chunks every doc into ~800-token segments
(100-token overlap), embeds with Voyage voyage-3-large, and inserts into
`dymaxion.messages` with `gateway: 'system-seed'`, `direction: 'reference'`.
Re-run with `--refresh` to re-embed only files whose mtime is newer than
their last embedding. Reload is idempotent (old chunks for a file are
replaced).

## Adding domain packs (Sprint 2+)

Create `domains/<name>/` with 15-30 docs in the same format (utilities,
insurance, real-estate, local-government, environmental, ...). Enable per
project via `dymaxion.projects.context.knowledge_domains`.

## Never in the knowledge base

- Any City of Sacramento internal document, system detail, or vendor-specific ArcGIS Online configuration
- Any client-confidential data model or SOP
- Any paid-source content without a license permitting embedding
