# GISBench

GISBench contains exactly thirty-five reproducible golden tasks across the
seven implemented native capabilities.

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

Phase 1B — deterministic read-only `trace_arcgis_dependencies`
(fixture-backed ArcGIS Portal REST item metadata/data, no network access):

11. valid Web Mapping Application → Web Map → item/service dependency graph
    with sanitized, never-dispatched service leaves and impact summaries;
12. cycle detection with canonical duplicate-reference deduplication;
13. missing-item, malformed-id, credential-bearing-URL, and
    unsupported-scheme handling with deterministic warnings and zero secret
    leakage;
14. honest node-ceiling truncation with explicit reasons;
15. employer-boundary rejection of a denied portal hostname before any
    request.

Phase 1C — deterministic read-only `query_feature_service` (fixture-backed
ArcGIS FeatureServer REST layer metadata and POST-form `/query`, no network
access):

16. basic attribute query with canonical object-ID discovery and batch
    paging (unsorted server IDs and shuffled page order normalize to one
    canonical report);
17. optional geometry with an explicit output WKID (`outSR` in the POST
    form, sanitized Esri JSON geometry in the report);
18. `exceededTransferLimit` handling: the full batch fails honestly and the
    deterministic halves succeed, with every attempt request- and
    byte-accounted;
19. `max_records` ceiling truncation selecting the lowest canonical object
    IDs with explicit truncation reasons;
20. employer-boundary rejection of a denied FeatureServer hostname before
    any request.

Phase 1D — deterministic read-only `validate_spatial_data` (local synthetic
GeoJSON fixtures, no network access):

21. clean polygon/point FeatureCollection with an enclosing declared bbox
    (`valid: true`, zero findings, full checks-run/checks-not-run scope);
22. geometry defect findings (unclosed ring, bow-tie self-intersection with
    a non-intersecting control, duplicate vertices, short LineString,
    zero-area ring, out-of-range position, mixed coordinate dimensions)
    sorted deterministically with `valid: false`;
23. identifier and null QA (missing/duplicate/invalid typed feature IDs,
    null geometry, stable property-null profile) with no raw untrusted
    values echoed;
24. stable issue-ceiling truncation (`max_issues: 1`): the error survives
    over an earlier-encountered warning because sorting precedes truncation,
    while summary totals still count every finding;
25. filesystem boundary-escape rejection before any invocation recording or
    dataset I/O.

Phase 1E — deterministic read-only `generate_map_artifact` (local synthetic
GeoJSON fixtures to inline static SVG, no network or artifact write):

26. useful mixed geometry rendering with points, lines, polygon hole,
    GeometryCollection, structured legend and exact SVG evidence hash;
27. antimeridian-crossing LineString fitted through a minimal circular
    longitude interval rather than stretched across the world;
28. explicit empty FeatureCollection contract with full-world viewport and
    no-drawable-geometry message;
29. CRS84 out-of-range coordinate rejection after bounded local parsing;
30. filesystem boundary-escape rejection before invocation recording or
    dataset I/O.

Phase 1F — deterministic read-only `run_vector_analysis` (two local
synthetic RFC 7946 Point FeatureCollections to inline canonical GeoJSON, no
network or artifact write):

31. normal nearest-point matching with stable output ordering, rounded
    Haversine distances, primary property/ID preservation, and candidate
    property omission;
32. rounded-distance tie resolved by lower candidate source index;
33. antimeridian-aware nearest selection using normalized longitude deltas;
34. `max_distance_meters` threshold yielding an unmatched primary feature;
35. empty candidate FeatureCollection yielding unmatched primary features.

Each versioned task declares its golden output/error, numeric tolerance,
explicitly normalized environment-dependent fields, permitted operations, and
expected approval behavior. ArcGIS tasks resolve requests through an
exact-match fixture transport (`fixtures/arcgis/*/routes.json`, matching
method, URL, and canonicalized POST form entries) with stubbed DNS, so no
live DNS lookup or HTTP request ever occurs, and any unexpected request
fails the task closed. All fixtures are
synthetic CC0 test data described in `fixtures/PROVENANCE.md`; none use City
of Sacramento, client, employer, authenticated ArcGIS, or production data.

Run from `dymaxion-runtime/`:

```bash
npm run gisbench
```

The runner fixes the evidence retrieval clock. For Phase 0 dataset tasks it
normalizes checkout-dependent source paths, filesystem modification time, and
hashes/canonical parameter fields that incorporate those paths. Phase 1D,
Phase 1E, and Phase 1F local-file evidence deliberately carries no filesystem
mtime (its
`source.version` is empty for same-byte determinism), so those tasks normalize
only path-dependent source/parameter fields; the Phase 1E SVG content and
Phase 1F canonical GeoJSON artifact content plus their hashes remain
unnormalized because they are checkout-independent. ArcGIS tasks
are fully deterministic and normalize nothing.

Evidence hashes (source, canonical parameters, output artifacts, per-request
bodies) are validated before comparison. Phase 1C query evidence additionally
validates POST methods, canonical request-body hashes and absence of query
strings from query evidence URLs. Phase 1D, Phase 1E, and Phase 1F evidence is
checked against source SHA-256 values **recomputed from the actual raw fixture
bytes** — report and evidence source hashes must equal those bytes, so jointly
forged source hashes fail closed. Phase 1D also validates its canonical
parameter/report hashes and mirrors dataset validity into evidence. Phase 1E
recomputes the exact UTF-8 SVG byte count and SHA-256 and requires artifact,
report and evidence output metadata to agree before normalization; jointly
forged SVG hashes fail closed. Phase 1F recomputes exact UTF-8 GeoJSON artifact
bytes and SHA-256 and requires artifact, report and evidence output metadata to
agree before normalization; jointly forged nearest-point artifact hashes fail
closed. GISBench remains an evaluation scaffold — thirty-five tasks toward the
100-task roadmap goal, not a claim of broad GIS coverage.
