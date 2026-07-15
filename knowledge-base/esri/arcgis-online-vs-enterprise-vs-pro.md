---
title: ArcGIS Online vs ArcGIS Enterprise vs ArcGIS Pro
category: esri
topic_tags: [arcgis-online, arcgis-enterprise, arcgis-pro, platform, deployment]
status: stub
---

# ArcGIS Online vs ArcGIS Enterprise vs ArcGIS Pro

Explains the three pillars of the Esri platform and when to use each. ArcGIS Online (AGOL) is Esri's SaaS at arcgis.com: hosted feature layers, web maps, apps, and credits-based storage/analysis, with no infrastructure to manage. ArcGIS Enterprise is the self-hosted equivalent — Portal for ArcGIS, ArcGIS Server, ArcGIS Data Store, and Web Adaptor — deployed on-premises or in your own cloud when data sovereignty, air-gapping, or database-backed (referenced) services are required. ArcGIS Pro is the 64-bit Windows desktop application for authoring, analysis, and geoprocessing; it signs in to either AGOL or Enterprise as its active portal and is the publishing client for both. Key decision factors covered: hosted vs referenced feature layers, credit consumption vs server sizing, update cadence (AGOL updates continuously, Enterprise on your schedule), and utility services (geocoding, routing, elevation) availability. Also covers the sharing model differences — AGOL organizations vs Enterprise portals with federated servers — and how Pro licenses can be assigned from either. Interoperability notes: content can be distributed via distributed collaboration between AGOL and Enterprise, and the ArcGIS REST API surface is nearly identical across both.

TODO: expand from authoritative source (doc.arcgis.com and enterprise.arcgis.com product documentation).
