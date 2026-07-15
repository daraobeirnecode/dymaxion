---
title: Multi-Tenancy Patterns for Hosted GIS
category: architecture
topic_tags: [multi-tenancy, isolation, row-level-security, saas, postgres-schemas, workspaces]
status: stub
---

# Multi-Tenancy Patterns for Hosted GIS

Hosting GIS for multiple clients forces an isolation choice with three classic tiers: shared tables with a `tenant_id` column enforced by Postgres row-level security (`CREATE POLICY tenant_isolation ON parcels USING (tenant_id = current_setting('app.tenant_id')::uuid)`), schema-per-tenant in one database (clean namespace, easy per-tenant backup via `pg_dump -n`, moderate migration overhead), and database- or cluster-per-tenant (strongest isolation, highest cost, needed for regulated clients). RLS is the cheapest but demands discipline: every connection must set the tenant GUC, `BYPASSRLS` roles must be audited, and spatial indexes are shared so one tenant's 50M-row load affects neighbors' query plans. Tile and service layers need matching isolation: GeoServer workspaces + data-security rules per tenant (or GeoFence for finer policies), separate pg_tileserv/Martin instances or path-prefixed routing per tenant, and tile URLs that embed a tenant token so caches cannot cross-serve. In the Esri world, tenancy maps to separate AGOL organizations or Enterprise portals — folders/groups inside one org are sharing controls, not security boundaries against admins, and should not be sold as tenant isolation. Cross-cutting concerns that leak across tenants if unplanned: extents in service capabilities documents, geocoder/logging data, global caches keyed only by z/x/y, and background jobs that iterate all tenants in one transaction. Meter per tenant from day one (rows, storage, tile requests, compute seconds) even if billing is flat, because the first pricing dispute will demand history. Noisy-neighbor mitigation: statement timeouts, per-tenant connection pools (PgBouncer databases), and render queue fairness. Rule of thumb: RLS for many small tenants of one application, schema-per-tenant for tens of clients with divergent models, database-per-tenant when contracts or compliance say the word "isolated."

TODO: expand from authoritative source (PostgreSQL row-level security docs; GeoServer security subsystem docs; SaaS multi-tenancy architecture literature).
