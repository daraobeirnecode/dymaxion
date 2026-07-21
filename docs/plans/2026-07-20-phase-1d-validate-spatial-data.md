# Phase 1D `validate_spatial_data` Implementation Plan

> **For Hermes:** Use Claude Code/Fable 5 as the sole product-code writer. Mercator may prepare this brief, inspect, run gates, and send concrete findings back to the same Fable session. Do not publish until an independent exact-SHA Tyr review approves the final commit.

**Goal:** Add a deterministic, read-only `validate_spatial_data` native capability that performs bounded, honest spatial QA on one allowlisted local RFC 7946 GeoJSON FeatureCollection and produces a structured validation report plus reproducible evidence.

**Architecture:** Reuse Dymaxion’s strict capability schemas, shared runtime dispatcher, filesystem boundary enforcement, canonical hashing, evidence contract, cancellation model, and GISBench golden-fixture pattern. Phase 1D supports local `.geojson` only. It performs defensible structural and bounded geometry checks itself and explicitly reports checks that are not performed; it must never imply full OGC/GEOS topology coverage.

**Tech Stack:** TypeScript/Node.js 22+, Zod, Node test runner, existing canonical/evidence/runtime contracts. Prefer no new runtime dependency. If a geometry dependency is genuinely necessary, stop and document the dependency/supply-chain/runtime trade-off before adding it.

---

## Scope and non-goals

### In scope

- One allowlisted local `.geojson` FeatureCollection.
- Strict versioned input/output contracts.
- Read-only execution through the real `runSkill()` dispatcher.
- Bounded file, feature, coordinate, issue, duration and cancellation handling.
- Deterministic issue codes, severity, locations, ordering and hashes.
- Structural GeoJSON validation plus the explicitly enumerated geometry/attribute checks below.
- Five synthetic fixture-backed GISBench tasks, raising the suite from 20 to 25.
- Capability documentation and truthful implemented-capability counts.

### Out of scope

- ArcGIS REST, authenticated/private services, URLs or network access.
- Shapefile, GeoPackage, File Geodatabase, CSV, raster or database inputs.
- Reprojection, repair, mutation, publication or write approval.
- Full OGC Simple Features validity, robust GEOS equivalence, polygon hole containment/overlap, cross-feature topology or domain/subtype validation.
- External processes, GDAL/QGIS/ArcPy, PostGIS, MCP, LLM calls or live GIS systems.
- Push, PR, merge or deployment.

## Required contract

### Input

Use a strict schema with:

- `source_uri: string` — required local path, enforced by the shared boundary before invocation persistence and again canonicalized by the capability.
- `max_bytes?: integer` — positive, capped by the manifest ceiling.
- `max_features?: integer` — positive, capped by the manifest ceiling.
- `max_issues?: integer` — positive, capped by the manifest ceiling; controls returned issue detail only, not whether validation continues or summary totals.

Do not accept arbitrary check names, CRS overrides, credential-like fields, output paths or remote URLs.

### Output

Return strict schema version `1.0.0` with:

- `report.schema_version`.
- Canonical file source URI/handle, retrieval timestamp, file SHA-256 and byte count.
- Declared/effective CRS metadata. Absence of a deprecated `crs` member means RFC 7946 `OGC:CRS84`, longitude/latitude, degrees. A present legacy `crs` member receives a warning and disables CRS84 range assumptions unless the name is exactly recognized.
- `scope.checks_run` and `scope.checks_not_run`, using stable machine-readable identifiers and reasons for every intentionally unsupported topology/domain check.
- `summary` with feature count, coordinate-position count, total findings by severity, returned finding count, truncation state, and `valid` where only error-severity findings make the dataset invalid.
- `issues`: typed stable issue records containing machine-readable `code`, `severity` (`error` or `warning`), stable location, and bounded human-readable message. Sort by severity rank, code and stable location before applying `max_issues`; never let encounter order select survivors.
- Useful metrics: null geometries, missing IDs, duplicate IDs, geometry type counts, coordinate dimensions, out-of-range positions, unclosed rings, degenerate rings and self-intersections detected by the bounded Phase 1D algorithm.
- Reproducible `EvidenceBundleSchema` evidence. The output artifact hash must validate against the canonical report before GISBench normalization.

Do not serialize raw file contents, full coordinate arrays, secrets or arbitrary exception text.

## Required checks

1. JSON syntax and FeatureCollection/Feature/property/geometry structure.
2. Feature ceiling before geometry traversal.
3. Feature IDs:
   - GeoJSON string/number IDs accepted.
   - Missing IDs are warnings.
   - Duplicate typed canonical IDs are errors.
4. Null geometries are warnings.
5. Supported geometry types: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon and GeometryCollection.
6. GeometryCollection recursion depth and total coordinate-position ceilings.
7. Position arrays require at least two finite numeric ordinates; dimensions must be internally consistent within each geometry. Preserve only bounded location metadata, never coordinates, in findings.
8. For effective CRS84, validate longitude in `[-180, 180]` and latitude in `[-90, 90]`.
9. LineString requires at least two positions.
10. Polygon rings require at least four positions and exact first/last closure.
11. Detect consecutive duplicate vertices and zero signed-area rings.
12. Implement a deterministic bounded two-dimensional ring self-intersection check that ignores adjacent segments and the first/last adjacency. State its limitations; do not claim complete OGC validity.
13. Validate a declared GeoJSON `bbox` structurally and verify it encloses the computed two-dimensional extent when coordinates exist.
14. Property-null profiling: count null/missing values by field using stable sorted field names. Do not invent coded-value domain validation for GeoJSON; report it as not run/not applicable.
15. Every loop with potentially many features/coordinates/segments must check cancellation and deadline/limit accounting.

Malformed root/feature envelopes and hard resource-limit violations fail closed. Dataset-quality errors inside an otherwise parseable bounded FeatureCollection return a successful capability result whose report has `valid: false`.

## Resource ceilings

Keep limits explicit at module top and mirrored exactly in the manifest:

- file bytes: no higher than existing `inspect_dataset` (1,048,576 bytes) unless a documented reason and tests justify otherwise;
- features: 10,000 maximum;
- coordinate positions: choose and document a hard positive ceiling compatible with the byte cap;
- returned issues: default 200, hard maximum 1,000;
- GeometryCollection depth: hard small ceiling;
- duration: 5 seconds;
- cost: zero.

Stat before read, enforce actual bytes after read, and check cancellation before and after I/O. The report must honestly distinguish returned issue truncation from validation incompleteness. A coordinate/depth/deadline ceiling is a hard failure, not a partial “valid” report.

## Determinism and evidence

- Same input bytes, options and fixed `context.now` must produce byte-identical report/evidence hashes.
- Stable-sort fields, check lists, unsupported-check entries, geometry counts, property profiles and issues.
- Do not use locale-sensitive sorting.
- Evidence source hash is the raw file-byte SHA-256.
- Evidence parameter hash covers canonical source URI and effective limits.
- Evidence output hash covers the unnormalized validation report.
- `execution.capability` must be `validate_spatial_data`, version `1.0.0`, deterministic, no model planning.
- Rollback and approvals remain empty/not required because the capability is read-only.

## Task 1: Contract and failing tests

**Files:**

- Create: `dymaxion-runtime/src/capabilities/validate-spatial-data.ts`
- Create: `dymaxion-runtime/test/validate-spatial-data.test.ts`
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`

**Steps:**

1. Write strict manifest/input/output schema tests.
2. Write an end-to-end dispatcher test for a valid synthetic polygon FeatureCollection.
3. Write a deterministic repeated-run/hash test with fixed time.
4. Run the focused test and prove RED for the missing capability.
5. Implement only the schemas, manifest and registry wiring needed to progress.

## Task 2: Bounded validation engine

**Files:**

- Modify: `dymaxion-runtime/src/capabilities/validate-spatial-data.ts`
- Modify: `dymaxion-runtime/test/validate-spatial-data.test.ts`
- Create focused fixtures under: `gisbench/fixtures/spatial-validation/`

**Steps:**

1. Add malformed, file/feature/coordinate/depth limit, cancellation and boundary-before-I/O tests.
2. Add feature ID, null geometry, position, dimension, CRS84 range and line/ring cardinality tests.
3. Add closed-ring, zero-area, consecutive-duplicate and bow-tie self-intersection tests, including non-intersecting controls.
4. Add bbox and stable property-null profile tests.
5. Implement the smallest deterministic bounded engine that passes each group.
6. Add an issue-order permutation test proving stable sorting before `max_issues` selection.

## Task 3: Evidence and runtime integration

**Files:**

- Modify: `dymaxion-runtime/src/capabilities/validate-spatial-data.ts`
- Modify: `dymaxion-runtime/test/validate-spatial-data.test.ts`
- Modify contract tests only if the native capability registry count is asserted.

**Steps:**

1. Add tests recomputing source, parameter and output hashes from returned data.
2. Add strict output-schema rejection tests.
3. Verify real `runSkill()` boundary preflight occurs before recorder/I/O.
4. Add canary tests ensuring raw contents and coordinate values are absent from issues/evidence/errors.
5. Complete report/evidence generation and dispatcher behavior.

## Task 4: GISBench 21–25

**Files:**

- Modify: `dymaxion-runtime/src/gisbench/run.ts`
- Create: `gisbench/tasks/21-validate-valid-polygon.json`
- Create: `gisbench/tasks/22-validate-geometry-findings.json`
- Create: `gisbench/tasks/23-validate-identifiers-and-nulls.json`
- Create: `gisbench/tasks/24-validate-issue-ceiling.json`
- Create: `gisbench/tasks/25-validate-boundary-reject.json`
- Create/update matching synthetic fixtures and `gisbench/golden/*.golden.json` through the repository’s update mechanism only.

**Steps:**

1. Add a strict discriminated task schema and real dispatcher path for `validate_spatial_data`.
2. Validate evidence hashes before golden normalization.
3. Add five tasks covering valid data, geometry findings, ID/null QA, stable issue truncation and boundary rejection.
4. Raise the exact task count from 20 to 25.
5. Generate goldens with `npm run gisbench -- --update-goldens`, then rerun without update and require 25/25.

## Task 5: Documentation and clean gates

**Files:**

- Create: `docs/capabilities/validate-spatial-data.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify any authoritative capability-count documentation found by exact search.

**Steps:**

1. Document exact supported checks, limits, issue semantics and explicit non-goals.
2. Update implemented native capability count from four to five only after implementation passes.
3. Update GISBench count from twenty to twenty-five.
4. Remove stale “current Phase 1C” wording and identify Phase 1D as complete only when true.
5. Run all acceptance gates below and fix failures without broad unrelated rewrites.

## Acceptance gates

From `dymaxion-runtime`:

```bash
npm run typecheck
node --import tsx --test test/validate-spatial-data.test.ts
npm test
npm run gisbench
npm run build
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test
npm audit --omit=dev --audit-level=moderate
```

Repository-wide:

```bash
cd ../dymaxion-admin && npm test && npm run build && npm audit --omit=dev --audit-level=low
cd ../windows-worker && npm run typecheck && npm test && npm run build && npm audit --omit=dev --audit-level=low
cd .. && docker compose config -q
git diff --check
python3 scripts/ci_source_integrity.py origin/main HEAD
```

If `scripts/ci_source_integrity.py origin/main HEAD` cannot inspect uncommitted work, run the repository/worktree source scan and rerun the script after the local release commit. Scan tracked and untracked changed files for literal NULs, symlinks, unexpected binaries, oversized files and credential patterns before staging.

## Publication boundary

Fable may edit, install dependencies if explicitly justified, and run local checks. Fable must not commit, push, open/modify PRs, merge, deploy, read credentials, query live GIS services or touch files outside this worktree. Mercator independently inspects and verifies the final worktree, sends findings back to the same Fable session, creates the release commit, requests Tyr’s exact-SHA review, and asks/uses separate publication authorization as applicable.
