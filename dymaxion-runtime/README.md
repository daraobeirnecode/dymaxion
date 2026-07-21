# Dymaxion runtime

`dymaxion-runtime` is the TypeScript/Node.js 22+ runtime for the Dymaxion GIS
agent. It currently implements seven native, versioned, read-only capabilities:

1. `inspect_dataset`
2. `inspect_arcgis_org`
3. `trace_arcgis_dependencies`
4. `query_feature_service`
5. `validate_spatial_data`
6. `generate_map_artifact`
7. `run_vector_analysis`

## `run_vector_analysis` (Phase 1F)

Phase 1F adds deterministic local vector analysis. The only supported operation
is `nearest_point`.

Input contract:

```json
{
  "source_uri": "/absolute/or/workspace-relative/primary.geojson",
  "candidate_source_uri": "/absolute/or/workspace-relative/candidates.geojson",
  "operation": "nearest_point",
  "max_distance_meters": 1000
}
```

- `source_uri` and `candidate_source_uri` are required raw local filesystem
  paths to distinct `.geojson` files.
- Both files must be RFC 7946 CRS84 GeoJSON `FeatureCollection`s containing
  non-null `Point` features only.
- `operation` defaults to `nearest_point`; no other vector operation is exposed.
- `max_distance_meters` is optional. When present, a nearest candidate whose
  rounded distance exceeds the threshold yields an unmatched output feature.

The output is an inline derived GeoJSON `FeatureCollection` artifact plus a
structured report and versioned evidence. Primary feature IDs, geometry, and
properties are preserved, except primary properties using the reserved
`_dymaxion` namespace are rejected. Candidate properties are never copied into
the output artifact; only the matched candidate index, candidate ID, rounded
distance, operation, and matched/unmatched flag are added under
`properties._dymaxion`.

Distance semantics are deterministic: Haversine spherical great-circle distance
with fixed authalic radius `6,371,008.8` meters, longitude deltas normalized
across the antimeridian to `[-180,180]`, distance rounded to the nearest
millimetre, and ties resolved by lower candidate source index.

Hard limits:

- per-source bytes: `1,048,576`
- combined source bytes: `2,097,152`
- primary features: `1,000`
- candidate features: `1,000`
- pair evaluations: `250,000`
- output bytes: `2,097,152`
- duration: `5,000` ms with cancellation checkpoints
- coordinate positions: `2,000`
- coordinate ordinates: `8,000`
- JSON depth: `32`
- JSON nodes: `20,000`
- `max_distance_meters`: `> 0` and `<= 20,015,114.442035925`
- cost: `$0`

Safety and limitations:

- No network, DNS, portal, database, filesystem write, durable artifact write,
  or approval path is used.
- Raw local paths reject URL/URI syntax, authority forms, query/fragment
  delimiters, percent escapes, control characters, non-`.geojson` extensions,
  credential-shaped text, same-source aliases, and paths outside the configured
  workspace boundary.
- Spherical Point-only nearest-neighbor search only; no ellipsoidal geodesic,
  reprojection, topology validation, spatial index, geocoding, buffering,
  overlay, routing, or live-service analysis.
- The implementation is brute-force `O(n*m)` and returns an inline artifact;
  it does not create files or publish GIS services.

## GISBench

GISBench currently has exactly 35 committed golden tasks: 5 each for Phases 0,
1A, 1B, 1C, 1D, 1E, and 1F. Phase 1F contributes five offline fixture-backed
`run_vector_analysis` tasks covering normal nearest ordering, rounded-distance
tie-breaks, antimeridian selection, `max_distance_meters` unmatched output, and
empty candidate FeatureCollections.

Run from this directory:

```bash
npm run typecheck
npm test
npm run gisbench
```

To regenerate goldens through the official harness:

```bash
npm run gisbench -- --update-goldens
```
