# GISBench

GISBench contains exactly ten reproducible golden tasks across the two
implemented native capabilities.

Phase 0 — deterministic `inspect_dataset` (local GeoJSON):

1. valid point FeatureCollection passport;
2. mixed/null geometry QA warnings;
3. malformed GeoJSON rejection;
4. configured byte-limit rejection before content read;
5. filesystem boundary-escape rejection before dataset I/O.

Phase 1A — deterministic read-only `inspect_arcgis_org` (fixture-backed
ArcGIS Portal REST, no network access):

6. small synthetic public organization inventory (users, groups, items, services);
7. multi-page item pagination (`start`/`num`/`nextStart`, terminating on `-1`);
8. deterministic ownership/sharing/staleness governance findings;
9. ArcGIS REST error-envelope rejection (HTTP 200 envelope, secret redaction);
10. employer-boundary rejection of a denied hostname before any request.

Each versioned task declares its golden output/error, numeric tolerance,
explicitly normalized environment-dependent fields, permitted operations, and
expected approval behavior. ArcGIS tasks resolve requests through an
exact-URL fixture transport (`fixtures/arcgis/*/routes.json`) with stubbed
DNS, so no live DNS lookup or HTTP request ever occurs. All fixtures are
synthetic CC0 test data described in `fixtures/PROVENANCE.md`; none use City
of Sacramento, client, employer, authenticated ArcGIS, or production data.

Run from `dymaxion-runtime/`:

```bash
npm run gisbench
```

The runner fixes the evidence retrieval clock. For dataset tasks it
normalizes only checkout-dependent source paths, filesystem modification
time, and hashes/canonical parameter fields that incorporate those paths;
ArcGIS tasks are fully deterministic and normalize nothing. Evidence hashes
(source, canonical parameters, output artifacts, per-request bodies) are
validated before comparison. GISBench remains an evaluation scaffold — ten
tasks toward the 100-task roadmap goal, not a claim of broad GIS coverage.
