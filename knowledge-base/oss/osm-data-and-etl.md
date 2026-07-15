---
title: OpenStreetMap Data Model and ETL
category: oss
topic_tags: [openstreetmap, osm2pgsql, osmium, overpass, geofabrik, etl]
status: stub
---

# OpenStreetMap Data Model and ETL

OSM's data model has three primitives: nodes (points with lat/lon), ways (ordered node lists forming lines or closed rings), and relations (grouping members with roles — multipolygons, routes, turn restrictions), all carrying free-form key=value tags (`highway=residential`, `building=yes`, `amenity=school`) whose conventions live on the OSM wiki. Extracts: Geofabrik (`download.geofabrik.de`) publishes daily country/region `.osm.pbf` files, BBBike offers custom city extracts, planet.osm is the full ~80 GB PBF, and the Overpass API answers ad-hoc tag/area queries in OverpassQL (`node["amenity"="fire_station"](area:...)`) via overpass-turbo for small targeted pulls. Command-line ETL: osmium-tool is the swiss army knife — `osmium extract -b lon1,lat1,lon2,lat2 region.pbf -o clip.pbf`, `osmium tags-filter in.pbf w/highway -o roads.pbf`, `osmium export -f geojsonseq`, plus `osmium apply-changes` for minutely diffs; osmconvert/osmfilter are the older equivalents. Loading into PostGIS uses osm2pgsql: `osm2pgsql -d dymaxion --output=flex --style=my_style.lua region.pbf` — the modern flex output defines tables/columns/geometry transforms in Lua, replacing the legacy `planet_osm_point/line/polygon` C-style schema; `--append` with replication diffs keeps the database current against minutely updates (`osm2pgsql-replication`). Alternative loaders: ogr2ogr reads .pbf directly (5 fixed layers: points, lines, multipolygons, multilinestrings, other_relations — quick but lossy), imposm3 for curated schema mappings, and Planetiler/tilemaker skip the database entirely to emit MBTiles/PMTiles basemaps. Analysis-ready alternatives: the Daylight Distribution (validated OSM snapshot, discontinued 2024 but archived) and Overture Maps, which recasts OSM+other sources as schema-stable GeoParquet with persistent GERS ids. License: ODbL — share-alike applies to derived databases, and attribution "© OpenStreetMap contributors" is mandatory on maps.

TODO: expand from authoritative source (wiki.openstreetmap.org — Elements, osm2pgsql.org, osmcode.org/osmium-tool).
