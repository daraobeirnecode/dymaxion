---
title: ArcGIS Token Authentication and OAuth 2.0 Flows
category: esri
topic_tags: [authentication, oauth, token, generatetoken, api-key, security]
status: stub
---

# ArcGIS Token Authentication and OAuth 2.0 Flows

Explains the authentication options for the ArcGIS REST API and when each applies. Legacy token auth: POST username/password to `/sharing/rest/generateToken` (AGOL/Portal) or `/tokens/generateToken` (standalone ArcGIS Server) with `referer` or `requestip` client binding and an `expiration` in minutes; the returned token is passed as the `token` query parameter or `X-Esri-Authorization: Bearer` header. OAuth 2.0 is the recommended path: the authorization code flow (with PKCE) at `/sharing/rest/oauth2/authorize` and `/sharing/rest/oauth2/token` for user logins, and the client credentials flow (`grant_type=client_credentials` with a registered app's `client_id`/`client_secret`) for app-only access that consumes credits under the app's account. Covers refresh tokens (`grant_type=refresh_token`), token lifetimes, and the difference between user tokens (act as a named user, honor sharing) and app tokens (limited to services the app can access). API keys — long-lived scoped credentials created in the developer dashboard — suit location-service access (basemaps, geocoding, routing) but not private portal content administration. Enterprise adds IWA/PKI web-tier auth and SAML/OIDC logins, which still ultimately exchange into a portal token. Notes on 498 (invalid token) vs 499 (token required) error codes and the pitfall that ArcGIS returns auth errors with HTTP 200 and an `error` JSON body.

TODO: expand from authoritative source (developers.arcgis.com security and authentication documentation).
