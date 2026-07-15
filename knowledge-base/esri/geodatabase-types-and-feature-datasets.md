---
title: Geodatabase Types — File, Mobile, and Enterprise
category: esri
topic_tags: [geodatabase, file-geodatabase, enterprise-geodatabase, feature-dataset, feature-class, versioning]
status: stub
---

# Geodatabase Types — File, Mobile, and Enterprise

Compares the geodatabase flavors and their core containers. A file geodatabase (.gdb folder) is the default single-user workspace: up to 1 TB per dataset (configurable to 256 TB), supports compression and compaction, but no true multi-user editing or SQL access. A mobile geodatabase (.geodatabase) is SQLite-backed, introduced as a first-class workspace in Pro 2.7+, readable by SQL and suited to lightweight and offline workflows. An enterprise geodatabase is Esri's schema (created via the Enable Enterprise Geodatabase tool / `arcpy.management.EnableEnterpriseGeodatabase`) inside PostgreSQL, SQL Server, Oracle, or SAP HANA, unlocking versioning (traditional and branch), archiving, replication, and concurrent editing through .sde connection files. Inside any geodatabase: feature classes (point/line/polygon/multipatch tables with geometry), feature datasets (containers sharing one spatial reference, required for topologies, networks, and relationship classes that participate in them), tables, relationship classes, domains, subtypes, and attribute rules. Covers shapefile limitations that push work into geodatabases (10-character field names, 2 GB limit, no NULLs, single geometry type) and when each geodatabase type is the right recommendation. Notes that branch versioning is required for feature-service-based multi-user editing in modern deployments, while traditional versioning works through direct database connections.

TODO: expand from authoritative source (pro.arcgis.com "Types of geodatabases" documentation).
