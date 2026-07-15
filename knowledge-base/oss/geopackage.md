---
title: GeoPackage Format
category: oss
topic_tags: [geopackage, gpkg, sqlite, ogc, data-format, shapefile-replacement]
status: stub
---

# GeoPackage Format

GeoPackage (.gpkg) is an OGC standard container built on SQLite: one file holds multiple vector layers, raster tile pyramids, attributes, and (via extensions) styles — the modern replacement for shapefiles, which suffer 10-character field names, 2 GB limits, no null distinction, and multi-file fragility. Metadata tables `gpkg_contents`, `gpkg_geometry_columns`, and `gpkg_spatial_ref_sys` register layers and CRSs; spatial indexes are R-tree virtual tables maintained by triggers. Create and convert with `ogr2ogr -f GPKG output.gpkg input.shp -nln parcels`; append more layers to the same file with `-update -append` or just repeat `ogr2ogr` targeting the existing .gpkg. Because it is SQLite, you can query it directly (`sqlite3`, `ogrinfo -sql`, DuckDB, Python `sqlite3` + spatialite) and ship it as a single artifact — ideal for offline field apps (QField/Mergin Maps use it natively) and reproducible deliverables. QGIS treats GeoPackage as its default format and can store project files inside one. Practical limits: single-writer locking makes it wrong for concurrent multi-user editing (use PostGIS for that), and network filesystems can corrupt the WAL. Raster tiles in GPKG (`gpkg_tile_matrix`) overlap MBTiles' use case but with explicit CRS support beyond Web Mercator. List layers with `ogrinfo file.gpkg` and inspect a layer schema with `ogrinfo -so file.gpkg layername`.

TODO: expand from authoritative source (geopackage.org and gdal.org/drivers/vector/gpkg.html).
