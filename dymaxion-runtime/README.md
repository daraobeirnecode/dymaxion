# Dymaxion runtime

`dymaxion-runtime` is the TypeScript/Node.js 22+ runtime for the Dymaxion GIS
agent. It currently implements nine native, versioned capabilities:

1. `inspect_dataset`
2. `inspect_arcgis_org`
3. `trace_arcgis_dependencies`
4. `query_feature_service`
5. `validate_spatial_data`
6. `generate_map_artifact`
7. `run_vector_analysis`
8. `export_evidence_bundle`
9. `query_secured_feature_service`

## `arcgis_change_risk_packet` workflow

The shared `arcgis_change_risk_packet` workflow composes
`trace_arcgis_dependencies` and `export_evidence_bundle`; it does not add a
tenth capability. It deterministically renders `change-ticket.md`,
`dependency-map.svg`, and `evidence-bundle.zip`, fixes their identities during
preview, then requests one exact post-preview approval before any persistence.
The ZIP persisted by the approved capability is the exact previewed byte
sequence and SHA-256.

The agent planner/executor, `dymaxion change-risk-packet`, CLI gateway,
Telegram gateway, and Web/admin chat all use this same orchestration. Delivery
reopens trusted files and verifies byte count and SHA-256. Web sends only signed,
five-minute, path-free artifact tokens; the admin route authenticates the
operator and proxies the verified runtime download.

The workflow remains anonymous ArcGIS Online read-only. Item-provided service
URLs are evidence leaves and are never dispatched. It does not add Enterprise
access, ArcGIS writes, reverse-dependency discovery, arbitrary Python, or
authenticated inventory.

## `query_secured_feature_service` (Phase 2A capability + Phase 2B broker)

Phase 2A added governed authenticated, read-only Feature Service queries without
turning agent input into a credential or routing boundary. Input contains only a
configured `target_slug`, an opaque `credential_alias`, and the same bounded
query parameters supported by `query_feature_service`. `config/arcgis-targets.yaml`
is parsed as strict schema version `1.0.0`; the committed default has no targets.
Unknown versions/fields, duplicate slugs or aliases, non-canonical URLs,
unanchored ArcGIS Online service hosts, target/alias/portal/permission mismatches,
and expired broker descriptors fail closed.

The approval request binds the canonical parsed input to the logical target,
registry SHA-256, `feature-query` operation, agent run, capability, expiry, and
the broker-owned credential identity. Normal execution and replay use the same
approval resolver. Descriptor lookup does not materialize a token. Authorization
is requested only after the approved receipt is atomically consumed, validated
as a bounded Bearer header, and attached only to request headers—never URLs.

The capability reuses the anonymous query engine's metadata validation, object-ID
discovery, deterministic pagination/splitting, response completeness checks,
budgets and cancellation. Each metadata/page request independently revalidates
scheme, host, port, allowlist, DNS and resolved IP, and redirects are rejected.
Physical endpoints remain internal to enforcement; allowed and blocked boundary
audits, report URLs and evidence use `arcgis-target://<slug>` logical identities.
Responses or errors that echo authorization, credential identity, configured
URLs, or configured hostnames fail closed through secret-free error surfaces.

Phase 2B adds the opt-in PostgreSQL broker and migration-backed encrypted
envelope repository. The default remains unavailable unless
`DYMAXION_ARCGIS_TOKEN_BROKER` is exactly `postgres`; any other present value
fails closed. Deployment must explicitly configure each target and provision a
valid encrypted row through a separately reviewed trusted operator process.
There is no shipped OAuth, refresh, rotation, revocation, admin CRUD or plaintext
token ingestion path. Phase 2B does not edit features, administer portals,
publish services, accept arbitrary authenticated URLs, or contact live private
ArcGIS/PostGIS in tests. See
[`docs/capabilities/postgres-arcgis-token-broker.md`](../docs/capabilities/postgres-arcgis-token-broker.md)
for migration order, opt-in, expiry behavior, provisioning limits and validation
status.

## `export_evidence_bundle` (Phase 1G)

Phase 1G packages one strict report object, one strict upstream EvidenceBundle,
and one named inline UTF-8 artifact into a deterministic ZIP32 STORE archive.
The archive has exactly four members in fixed order:

1. `manifest.json`
2. `report.json`
3. `evidence.json`
4. `<validated-file-name>`

`preview` is copy-on-write: it assembles and hashes the exact candidate archive
without a filesystem mutation or approval. `persist` requires
`target_bundle_sha256` from preview and a fresh approval bound to the canonical
full input, exact project/bundle target, agent run, skill, configured execution
identity, and expiry. The one-execution grant is consumed once by the capability
and may be revalidated at each storage sink; the raw receipt is not sink
authority. Publication is project-scoped, create-only, content-addressed,
read-back verified, and idempotent only for exact existing bytes.
Export responses serialize no unsigned approval claims; the approval subsystem
and audit record remain authoritative for the consumed receipt and binding.
Injected `export_evidence.approvals` claims fail output validation.

The storage root is trusted runtime configuration (`DYMAXION_ARTIFACT_ROOT`) or
an injected internal adapter, never caller input. Symlinked roots/components,
path traversal, substitutions, non-directories, hash mismatches, quota excess,
and unauthorized sink creation fail closed. Approval facts are retained only by
the approval subsystem/audit record and are not embedded in the response or
archive, preserving preview/persist archive identity.

Hard limits: report `1 MiB`, upstream evidence `1 MiB`, artifact `2 MiB`, archive
input `4 MiB`, archive output `5 MiB`, four ZIP entries, JSON depth `32`, JSON
nodes `20,000`, 100 stored bundles/project, `64 MiB`/project, and a `5,000 ms`
deadline with cancellation checkpoints. This slice does not export raw source
data, publish GIS services, upload remotely, sign/encrypt archives, compress
members, update/delete artifacts, or provide a download endpoint.

Full contract: `../docs/capabilities/export-evidence-bundle.md`.

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

Safety, integrity, and limitations:

- No network, DNS, portal, database, filesystem write, durable artifact write,
  or approval path is used.
- Output validation cross-binds the inline artifact's UTF-8 byte count and
  SHA-256 hash through `artifact`, `report.output`, and the evidence output
  entry. The source SHA-256 values commit to the exact original source bytes,
  and reported source byte counts must match the evidence byte counts, but an
  unsigned output bundle cannot independently derive or authenticate original
  source byte length from a SHA-256 hash alone. Consumers requiring source-byte
  authenticity must verify the source files against both reported SHA-256 values
  and byte counts, or rely on an external trusted signature/attestation over the
  bundle and source observations.
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

GISBench currently has exactly 40 committed golden tasks: 5 each for Phases 0,
1A, 1B, 1C, 1D, 1E, 1F, and 1G. Phase 1G contributes five offline
`export_evidence_bundle` tasks covering useful preview, deterministic repeat,
approval-bound persist plus a fresh-approval exact-existing attempt, tamper/hash
mismatch rejection before approval/storage, and symlinked storage-root rejection.

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
