# Phase 1F `run_vector_analysis` Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task with read-only reviews before the release commit.

**Goal:** Add one deterministic, read-only inline vector-analysis operation: nearest Point feature in a candidate local GeoJSON FeatureCollection for every Point feature in a primary local GeoJSON FeatureCollection.

**Architecture:** Both approved raw local `.geojson` inputs are independently boundary-checked immediately before `stat` and `readFile`, decoded with fatal UTF-8, and parsed as strict RFC 7946 Point-only FeatureCollections. The capability computes bounded spherical great-circle distances with a fixed authalic Earth radius, selects matches by rounded millimetre distance then candidate source index, and returns a canonical inline GeoJSON artifact plus report and multi-source evidence. No source file is changed and no output file is written.

**Tech stack:** TypeScript/Node.js 22, Zod, existing canonical JSON/SHA-256 and capability/evidence contracts; no new runtime package.

---

## Locked MVP scope

- Slug/version/classification: `run_vector_analysis` v1.0.0, `read` for this inline MVP. The runtime currently treats every non-`read` classification as approval-required; because this phase writes no file or external state, classifying the returned in-memory artifact as `read` matches `generate_map_artifact`. Upgrade to `copy-on-write` only when project-scoped durable artifact storage exists.
- Operation: exactly `nearest_point`; no buffer, clip, intersect, dissolve, point-in-polygon, spatial join, routing, nearest line/polygon or aggregation.
- Inputs: `source_uri`, `candidate_source_uri`, optional `max_distance_meters`; unknown fields reject.
- Paths: raw local `.geojson` only. Reject schemes, query/fragment delimiters, controls, any percent escape and credential-shaped material before boundary audit, recorder or I/O.
- Data: RFC 7946 FeatureCollection roots only; every feature must have Point geometry, object/null properties and finite positions with valid longitude/latitude. Empty primary succeeds with empty output; empty candidates reject when primary is non-empty.
- Output: canonical `application/geo+json` FeatureCollection. Preserve each primary feature and properties, but reject a pre-existing reserved `_dymaxion` property. Add `_dymaxion.nearest_point` with candidate source index, optional candidate GeoJSON ID, rounded distance in metres and match status. Candidates' properties are never copied.
- Distance: spherical great-circle/Haversine with fixed authalic radius `6_371_008.8 m`; output rounded to millimetres. It is not an ellipsoidal/geodesic-engine or projected-distance claim.
- Tie-break: rounded distance ascending, then candidate source index ascending. Input ordering is preserved in output.
- Bounds: 1 MiB per source, 2 MiB combined bytes, 1,000 primary features, 1,000 candidates, 250,000 pair evaluations, 2 MiB output, five seconds, cancellation/deadline checkpoints during both file pipelines, every ordinate and every pair loop.
- No network, LLM, MCP, GDAL, QGIS, ArcPy, PostGIS, source mutation, durable artifact storage, approval bypass or deployment.

## Acceptance matrix

1. Sacramento-scale synthetic useful nearest matches with exact rounded distances and deterministic tie-breaks.
2. Antimeridian, identical-coordinate zero distance, near-polar and max-distance unmatched behavior.
3. Empty primary success; empty candidate/non-empty primary failure.
4. Reject non-Point/null geometry, legacy `crs`, malformed UTF-8/JSON, invalid envelopes, invalid positions/extra ordinates and reserved property collision.
5. Prove raw/encoded/credential/remote/boundary-denied paths reach no recorder/I/O/output leak; benign raw spaces, Unicode and credential-ish words remain valid.
6. Enforce per-file/combined bytes, feature counts, pair evaluations, output bytes, duration and cancellation with exploit-shaped tests.
7. Canonical output bytes/hash and report/evidence hashes reproduce exactly; changing either source bytes changes evidence.
8. Evidence represents the candidate as an explicit related local source, never as a fake HTTP retrieval request.
9. Five new GISBench tasks extend the suite from 30 to 35 without changing prior goldens.
10. Typecheck, focused/full tests, GISBench, build, smoke, audit, source integrity and exact-SHA independent review all pass.

## Tasks

### Task 1: Add additive related-source evidence

**Files:**
- Modify: `dymaxion-runtime/src/contracts/evidence.ts`
- Test: `dymaxion-runtime/test/evidence-contract.test.ts`

**Steps:**
1. Add a strict reusable local/remote source evidence schema matching the existing `source` object.
2. Add optional `related_sources`, each with a bounded `role`, source identity/version/hash and optional strict `gis_metadata`.
3. Keep the existing required singular `source` shape and all existing capability outputs byte-for-byte unchanged.
4. Write failing parse tests for valid candidate evidence and malformed/duplicate-role entries; implement minimal schema and rerun.

### Task 2: Extend capability limits without weakening old manifests

**Files:**
- Modify: `dymaxion-runtime/src/contracts/capability.ts`
- Test: `dymaxion-runtime/test/capability-contract.test.ts`

**Steps:**
1. Add optional strict positive integers `max_pair_evaluations` and `max_output_bytes` to `resource_limits`.
2. Prove older manifests parse unchanged and invalid/unknown limit fields still reject.

### Task 3: Implement the nearest-point capability with TDD

**Files:**
- Create: `dymaxion-runtime/src/capabilities/run-vector-analysis.ts`
- Create: `dymaxion-runtime/test/run-vector-analysis.test.ts`

**Steps:**
1. Write schema/manifest/registration-shape tests that initially fail.
2. Implement strict input/output schemas and constants matching the locked ceilings.
3. Implement two independent fail-closed local-file read pipelines with schema preflight, canonical boundary paths, boundary reassertion before every sink, fatal UTF-8, exact byte hashes and non-echoing I/O errors.
4. Implement Point-only RFC 7946 validation with per-ordinate paced checkpoints and no recursion.
5. Implement Haversine distance, millimetre rounding, max-distance filtering and deterministic candidate-index tie-break.
6. Construct canonical output GeoJSON with a reserved `_dymaxion.nearest_point` object; enforce output incrementally and at final bytes.
7. Build a strict report and evidence bundle binding both source hashes, canonical parsed parameters and exact output bytes/hash.
8. Add RED/GREEN tests for every acceptance-matrix case, including fake recorder/audit/I/O sink assertions.

### Task 4: Register and integrate the seventh native capability

**Files:**
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify tests with exact capability count assertions, including `dymaxion-runtime/test/query-feature-service.test.ts`

**Steps:**
1. Register `runVectorAnalysisCapability`.
2. Update exact native capability count from six to seven.
3. Run focused registry and capability tests.

### Task 5: Extend GISBench from 30 to 35 tasks

**Files:**
- Modify: `dymaxion-runtime/src/gisbench/run.ts`
- Modify: `dymaxion-runtime/test/gisbench-normalization.test.ts`
- Create: `gisbench/fixtures/vector-analysis/*.geojson`
- Create: `gisbench/tasks/31-*.json` through `35-*.json`
- Create: `gisbench/golden/*.json`
- Modify: `gisbench/fixtures/PROVENANCE.md`
- Modify: `gisbench/README.md`

**Steps:**
1. Add a strict vector-analysis task schema and allowed-operation vocabulary.
2. Derive exact canonical capability parameters independently from both fixture paths and parsed task defaults before normalization.
3. Add useful nearest, antimeridian/tie, max-distance unmatched, malformed geometry and boundary-rejection tasks.
4. Generate goldens from the implementation, inspect them, then prove old 30 plus new five pass exactly.

### Task 6: Document the truthful contract

**Files:**
- Create: `docs/capabilities/run-vector-analysis.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Steps:**
1. Document copy-on-write inline semantics, units/algorithm, limits, tie-break, source handling, evidence and all non-goals.
2. Update implemented native capability count to seven and GISBench count to 35.
3. Record implementation as GPT-5.6 Sol/Codex/Mercator; record delegated reviewers by actual model later.

### Task 7: Final-tree verification and review barrier

**Steps:**
1. Run focused tests, `npm run typecheck`, full `npm test`, `npm run gisbench`, `npm run build`, smoke and production audit.
2. Inspect status/diff/untracked files, old golden changes, secret/NUL/oversize/symlink findings and `git diff --check`.
3. Obtain independent stable-tree implementation review before committing.
4. Create immutable commit only after all implementation reviews close.
5. Run repository-native source integrity and Tyr exact-SHA review.
6. Publish/merge only after Tyr approval, exact-head CI, merge-head lock and post-merge `main` CI.
