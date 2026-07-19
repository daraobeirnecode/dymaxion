# GISBench Phase 0 MVP

GISBench Phase 0 contains exactly five reproducible tasks for the deterministic `inspect_dataset` capability:

1. valid point FeatureCollection passport;
2. mixed/null geometry QA warnings;
3. malformed GeoJSON rejection;
4. configured byte-limit rejection before content read;
5. filesystem boundary-escape rejection before dataset I/O.

Each versioned task declares its golden output/error, numeric tolerance, explicitly normalized environment-dependent fields, permitted operations, and expected approval behavior. All fixtures are synthetic CC0 test data described in `fixtures/PROVENANCE.md`; none use City of Sacramento, client, employer, authenticated ArcGIS, or production data.

Run from `dymaxion-runtime/`:

```bash
npm run gisbench
```

The runner fixes the evidence retrieval clock. It normalizes only checkout-dependent source paths, filesystem modification time, and hashes/canonical parameter fields that incorporate those paths. Dataset file hashes, GIS metadata, warnings, errors, operation traces, and approval expectations remain exact.
