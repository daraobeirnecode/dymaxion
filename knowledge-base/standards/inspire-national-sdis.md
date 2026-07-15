---
title: INSPIRE and National Spatial Data Infrastructures
category: standards
topic_tags: [inspire, sdi, metadata, iso-19115, open-data, geoportal]
status: stub
---

# INSPIRE and National Spatial Data Infrastructures

INSPIRE (EU Directive 2007/2/EC) is the most fully-specified SDI: it obligates EU member states to publish 34 spatial data themes (Annex I–III: addresses, cadastral parcels, hydrography, land use, etc.) with harmonized data models (UML→GML application schemas), ISO 19115/19139 metadata discoverable through national catalogs, and network services — originally view (WMS) and download (WFS/Atom), now increasingly OGC API Features under the "good practice" track. Its lasting lessons for any SDI: mandated metadata quality beats voluntary, harmonized schemas are the expensive part (data transformation, not serving), and monitoring/reporting requirements keep portals honest. The US equivalent is the NSDI coordinated by the FGDC: GeoPlatform.gov and data.gov catalogs, the National Map (USGS), and the Geospatial Data Act of 2018 formalizing agency responsibilities — lighter on schema harmonization than INSPIRE, heavier on lead-agency stewardship of framework themes (transportation, hydrography/NHD, elevation/3DEP, cadastre). Other reference SDIs: UK's data.gov.uk + OS OpenData, Australia/NZ's Digital Atlas and LINZ Data Service, and Canada's CGDI. California runs its own stack relevant to Dymaxion's work: the California State Geoportal (gis.data.ca.gov, an ArcGIS Hub instance), CalOES/CAL FIRE open data portals, and county open-data sites — practical discovery order for CA public data is state geoportal → agency portal → county hub. Catalog software to know: GeoNetwork and pycsw (CSW + OGC API Records), CKAN with ckanext-spatial (powering data.gov), and ArcGIS Hub for Esri-based agencies. Metadata reality: ISO 19115 (or its 19115-3 XML) remains the government lingua franca, while STAC and schema.org/Dataset (for Google Dataset Search indexing) are the web-native complements worth emitting alongside. When a client asks "how do agencies expect us to publish," the answer is an SDI pattern: catalog record + standardized service endpoint + open license statement.

TODO: expand from authoritative source (INSPIRE knowledge base at inspire.ec.europa.eu; FGDC/NSDI documentation; GeoNetwork and pycsw docs).
