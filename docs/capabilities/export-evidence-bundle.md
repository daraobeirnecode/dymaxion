# `export_evidence_bundle` — Phase 1G

`export_evidence_bundle` packages one bounded report, one upstream
`EvidenceBundle`, and one inline UTF-8 artifact into a deterministic,
content-addressed ZIP archive. It has no network or database path.

## Operations

### `preview`

`preview` is copy-on-write. It validates and canonicalizes every input, builds
the exact candidate ZIP bytes in memory, and returns the archive SHA-256,
content-addressed handle, manifest, export evidence, and member metadata. It
requires no approval and performs no filesystem mutation.

### `persist`

`persist` requires `target_bundle_sha256` equal to the preview archive hash. It
then requires a fresh approval bound to:

- canonical SHA-256 of the full persist input;
- exact target
  `capability:export_evidence_bundle|project:<project-id>|bundle:<archive-sha>`;
- `agentRunId` and `export_evidence_bundle` skill identity;
- configured trusted execution identity from
  `DYMAXION_CREDENTIAL_IDENTITIES_JSON`;
- approval decision and expiry.

The receipt can be claimed only once. The resulting execution grant can start
only one capability execution; that consumed grant is revalidated at every
storage sink. Raw receipts are not storage authority, forged grants fail, and
receipt/grant replay fails closed.

Publication is create-only and project-scoped. An exact existing archive returns
`created: false` only after byte/hash verification with a fresh approval. A
conflicting target is never overwritten.

## Deterministic archive

ZIP32 STORE is used with fixed timestamps, permissions, flags, headers, and
caller-defined entry order. The archive always has exactly four members:

1. `manifest.json`
2. `report.json`
3. `evidence.json`
4. `<validated artifact file_name>`

The three JSON members are UTF-8 canonical JSON. The manifest cross-binds exact
SHA-256 and byte counts for the report, evidence, and artifact members; it does
not contain a self-referential hash or byte count for `manifest.json`. Output validation independently
cross-binds archive, manifest, report, upstream evidence, artifact, replay
parameters, handle, operation, approval target, and storage verification facts.
Approval facts are not written into the archive or serialized into the export
response, so a persist of an approved preview retains the preview archive hash
without presenting unsigned approval claims as independently verifiable facts.
The approval subsystem and audit record remain authoritative for the consumed
receipt, exact payload hash, target, identity, operator, and timestamp;
`export_evidence.approvals` is always empty and injected claims are rejected.

The manifest explicitly records `raw_sources_included: false`. The artifact is
the provided derived output, not a source-dataset export.

## Trusted storage boundary

The root comes only from trusted runtime configuration
`DYMAXION_ARTIFACT_ROOT` or an injected internal storage adapter. It is never an
input field. Storage uses the layout:

```text
<trusted-root>/projects/<project-uuid>/artifacts/<archive-sha256>/bundle.zip
```

The public handle is opaque:

```text
artifact://project/<project-uuid>/bundle/<archive-sha256>
```

The implementation rejects root/component/final-target symlinks,
non-directories, traversal, lstat-to-open substitutions, hash mismatch,
unauthorized sink creation, quota excess, partial writes, and non-exact existing
targets. Writes use a same-directory exclusive temp file, sync, create-only
publication, directory sync, exact read-back verification, and cleanup.
Publication success is not reversed by a post-commit cleanup failure.

## Hard limits

| Limit | Value |
|---|---:|
| report canonical bytes | 1,048,576 |
| upstream evidence canonical bytes | 1,048,576 |
| inline artifact UTF-8 bytes | 2,097,152 |
| total ZIP input bytes | 4,194,304 |
| ZIP output bytes | 5,242,880 |
| ZIP entries | exactly 4 |
| JSON depth | 32 |
| JSON nodes | 20,000 |
| stored bundles per project | 100 |
| stored bytes per project | 67,108,864 |
| duration | 5,000 ms plus cancellation checkpoints |
| cost | $0 |

Names and media types are strict and bounded. Control characters, unsafe ZIP
names, duplicate entries, path separators in artifact file names, malformed
UTF-8, unknown fields, unsafe hashes, and non-finite JSON numbers reject before
approval or storage.

## Non-goals

Phase 1G does **not**:

- export raw source datasets;
- read arbitrary caller paths;
- fetch URLs or query ArcGIS services;
- upload, email, or publish archives;
- publish GIS services;
- sign, attest, or encrypt bundles;
- compress ZIP members;
- update or delete artifacts;
- provide a download/streaming endpoint;
- replace external signature or source-byte authenticity verification.

## Verification

From `dymaxion-runtime/`:

```bash
npm run typecheck
npm test
npm run gisbench
```

GISBench has five Phase 1G cases: useful preview, deterministic repeat,
approved persist plus a second fresh-approval exact-existing attempt, tampered
hash rejection before approval/storage, and symlinked/untrusted storage-root
rejection. Fixtures are synthetic and described in
`gisbench/fixtures/PROVENANCE.md`.
