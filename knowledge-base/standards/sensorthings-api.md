---
title: OGC SensorThings API
category: standards
topic_tags: [sensorthings, iot, observations, time-series, frost-server, odata]
status: stub
---

# OGC SensorThings API

SensorThings API (OGC 15-078r6 Part 1: Sensing, v1.1) is the OGC's REST/JSON standard for IoT sensor data, built on OData query conventions rather than the XML of its predecessor SOS. Its entity model chains Thing → Locations → Datastream → Sensor + ObservedProperty → Observations (+ FeatureOfInterest), so one gauge station (Thing) carries multiple Datastreams (stage, flow, temperature), each a typed time series of Observations. The OData-style query surface is the draw: `$filter` (including spatial functions like `st_within` and temporal predicates), `$expand` to inline related entities, `$orderby`, `$top`/`$skip` paging, and `$select` — e.g. `/Datastreams(42)/Observations?$filter=phenomenonTime ge 2026-01-01T00:00:00Z&$orderby=phenomenonTime desc`. Part 2 (Tasking) adds actuator control; MQTT publish/subscribe is specified for real-time observation streaming alongside HTTP. FROST-Server (Fraunhofer, Java + PostGIS backend) is the reference-grade open implementation; SensorUp provides commercial hosting, and clients exist for Python (`frost-client` and plain requests) and QGIS via plugins. It is deployed in production for hydrology, air quality, and smart-city networks (e.g. European environmental agencies expose SensorThings endpoints), and pairs naturally with the OGC API — EDR pattern for spatially-queried retrieval. Model observations with correct `phenomenonTime` vs `resultTime` semantics (when measured vs when recorded) — conflating them corrupts any latency analysis. For Dymaxion-style work, SensorThings is the standards answer when a client asks how to publish stream-gauge or telemetry time series interoperably instead of inventing a bespoke API.

TODO: expand from authoritative source (OGC SensorThings API Part 1 v1.1 spec, docs.ogc.org; FROST-Server documentation).
