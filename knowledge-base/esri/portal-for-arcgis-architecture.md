---
title: Portal for ArcGIS Architecture (ArcGIS Enterprise Base Deployment)
category: esri
topic_tags: [arcgis-enterprise, portal, hosting-server, data-store, web-adaptor, federation]
status: stub
---

# Portal for ArcGIS Architecture (ArcGIS Enterprise Base Deployment)

Describes the four components of a base ArcGIS Enterprise deployment and how they fit together. Portal for ArcGIS (port 7443) provides the identity store, item catalog, and Sharing API at `/portal/sharing/rest`. ArcGIS Server (port 6443) is the compute tier exposing services at `/server/rest/services`; when federated with the portal and designated the hosting server it powers hosted feature layers. ArcGIS Data Store manages the relational store (hosted feature data), tile cache store (hosted scene layers), and spatiotemporal big data store — it is not a user-managed geodatabase. The Web Adaptor (IIS/Java) fronts both on port 443, providing a single public URL and optional web-tier authentication. Covers federation vs standalone servers, additional server roles (GeoEvent, Image Server, GeoAnalytics, Notebook Server, Knowledge Server), and high-availability patterns (multi-machine portal, load-balanced server sites). Explains referenced services from enterprise geodatabases (registered data stores) versus hosted layers copied into the Data Store. Also notes ArcGIS Enterprise on Kubernetes as the alternative architecture that replaces these discrete components with pods and a single API.

TODO: expand from authoritative source (enterprise.arcgis.com "Base ArcGIS Enterprise deployment" documentation).
