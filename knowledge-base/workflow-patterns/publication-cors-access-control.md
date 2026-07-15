---
title: "Publication: CORS and Access-Control Patterns"
category: workflow-patterns
topic_tags: [cors, access-control, security, tokens, geoserver, api-keys]
status: stub
---

# Publication: CORS and Access-Control Patterns

Browsers block cross-origin XHR/fetch to map services unless the server sends `Access-Control-Allow-Origin` — the classic symptom is a layer that loads in Postman and 404s-silently in MapLibre or the JS API console with a CORS error. Configure it at the right layer: GeoServer needs the Jetty/Tomcat CORS filter enabled in `web.xml` (it ships commented out); ArcGIS Online lets org admins restrict allowed origins; ArcGIS Enterprise handles CORS on the web adaptor/reverse proxy; for Koop/pg_tileserv/Martin it is usually an Express/nginx header. Never ship `Access-Control-Allow-Origin: *` together with `Access-Control-Allow-Credentials: true` — the spec forbids it and browsers reject it; use an explicit origin allowlist when cookies or tokens ride along. Auth patterns by ecosystem: ArcGIS token-based auth (short-lived tokens from `/sharing/rest/generateToken` or OAuth 2.0 client credentials), API keys for location services, GeoServer role-based data security (`layer.security` rules or GeoFence for row/attribute-level policies), and signed URLs or CDN-edge auth for static PMTiles on object storage. Distinguish "secure the service" from "secure the item": an ArcGIS Online item can be private while its service URL is still guessable — service-level sharing is what actually gates REST access. Keep public read-only endpoints on a separate service (or view layer with `capabilities: Query` only) from any editable service, so approval-gated writes are structurally separated. Preflight (OPTIONS) requests must not require auth, or the browser never reaches the real call — a frequent misconfiguration behind reverse proxies. Log denied origins; they reveal both misconfigurations and scraping.

TODO: expand from authoritative source (MDN CORS reference; GeoServer security and CORS docs; ArcGIS Enterprise/Online security best practices).
