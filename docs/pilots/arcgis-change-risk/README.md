# ArcGIS change-risk value pilot

**Status:** value pilot merged; operator change-ticket packet enrichment in progress<br>
**Current branch:** `feat/operator-change-risk-packet`<br>
**Pilot merge baseline:** `c8117615c77c462794f30b9992584445c769d3d7` ([PR #11](https://github.com/daraobeirnecode/dymaxion/pull/11))<br>
**Model attribution:** Fable 5 authored the Phase 1 capability baseline and initial operator-packet implementation. A GPT-5.5 worker drafted the value-pilot runner; Mercator (GPT-5.6 Sol/Codex) materially corrected, executed, reviewed, and released that pilot, then materially hardened the operator packet's schemas, rendering and export sinks, exact-Node command, exploit regressions, verification, and documentation. The current enrichment still requires independent review and exact-SHA approval before merge.

## User and decision

The pilot user is an ArcGIS platform administrator preparing a review before changing or retiring a public Web Mapping Application. The practical question is:

> Which supporting Web Map, item, service, and visible owner references must be reviewed, and can the review evidence be packaged reproducibly?

This pilot decides whether the existing Dymaxion capabilities provide enough measurable workflow value to justify another development slice. It does **not** validate authenticated inventory, reverse dependency search, production deployment, or financial ROI.

## Product-value hypothesis

A platform administrator can replace manual app/item JSON inspection with one bounded, auditable workflow that:

1. traces only the documented `Web Mapping Application → Web Map → item/service` paths;
2. summarizes the visible dependency and ownership footprint;
3. flags missing, unresolved, unsupported, or truncated coverage;
4. creates and persists a deterministic evidence bundle; and
5. produces enough source references for a human to spot-check the result.

## Public target criteria

Every case must be:

- anonymously accessible through ArcGIS Online REST;
- outside all Sacramento/City employer systems and data;
- an exact `Web Mapping Application` with one supported public Web Map reference;
- owned by an identifiable public organization;
- plausible as a change or retirement review rather than a synthetic benchmark;
- diverse enough to exercise small and larger dependency footprints; and
- treated as untrusted read-only data. No item-provided service URL is contacted.

## Locked cases

| Case | Public organization | App item | Web Map | Minimum outgoing supported references from Web Map | Review posture |
|---|---|---|---|---:|---|
| `juneau-old-public-gis` | Juneau County, Wisconsin | `ba201516e5ed4c289d33150f640fdfb2` | `7cd80aa02a95494e976261f56d883200` | 7 | Explicitly labelled “OLD”; retirement/cleanup review |
| `la-county-cannabis-zones` | County of Los Angeles | `df60d1a4b1014df7866949fe46519711` | `bf87b9c1dddf46c7a01cbdd9753eca89` | 24 | Higher-complexity policy/zoning application |
| `tweed-planning-detail` | Tweed Shire Council | `227c90c55bbf41f38453fab13e58f492` | `f14affbcc56b4cddafc5c7624f0ceab2` | 22 | Public planning-detail workflow |

Candidate validation on 2026-07-22 confirmed public app and Web Map metadata, the supported app→map link, public organizations, and no Sacramento reference. The manifest values are lower bounds for supported direct graph edges, not exact source-container counts: one Web Map entry can yield both item and service edges. Anonymous `/portals/{org}/users` requests returned ArcGIS error `403`; therefore the pilot does not run or claim organization-user inventory. Visible owners come only from public item metadata in the dependency graph.

## Measurements

For each case the runner records:

- wall-clock duration for dependency trace, bundle preview, and approved local persist;
- dispatched ArcGIS request count and response bytes from evidence;
- node, edge, item, service-leaf, owner, missing, unresolved, cycle, warning, and truncation counts;
- root and dependency metadata available in the bounded graph;
- canonical dependency-report hash and retrieval-timestamp-neutral graph-structure hash;
- deterministic archive SHA-256, bytes, opaque handle, and read-back verification;
- a second independent live trace and whether full report, graph-structure, and archive hashes match;
- differences when hashes do not match; and
- manual REST spot-check results for a deterministic sample of up to three graph references.

## Pass/fail gate

The pilot passes only when:

- all three cases complete through `runSkill` using the production capability registry;
- every persisted evidence bundle is read back and hash-verified;
- every case exposes at least one supporting item or service reference;
- sampled item relationships match the corresponding public ArcGIS item data;
- repeat behavior is deterministic or any change is attributable to remote source changes or retrieval timestamps;
- no result is truncated without an explicit caveat;
- owner and dependency coverage limitations are present in every report; and
- after the release candidate is frozen, no more than two additional material product/security corrections are required across the final rerun and release review; a third changes the verdict to `needs another pilot run` and blocks value claims; and
- independent review finds no material overclaim or reproducibility defect.

A material correction is a code, schema, or security change needed to make the product output valid; verifier-only harness fixes are recorded separately. This ceiling was frozen during release review before the final rerun, not before the exploratory run, so it applies only after candidate freeze and is not presented as an original predeclared success criterion.

A successful technical run is **not** proof of customer value. The next slice proceeds only if the output is plausibly actionable and the residual manual work is clear. No time-saved, cost-saved, or revenue claim is allowed without a human comparison baseline.

## Smallest implementation

The pilot adds no native capability. It adds a developer runner and fixed case manifest that compose existing capabilities:

1. `trace_arcgis_dependencies` against the public portal and app root;
2. deterministic derivation of a concise change-risk review from that output, including a descriptive review-scope band that is explicitly not an operational-risk score;
3. deterministic SVG summary bound into the upstream evidence output;
4. `export_evidence_bundle` preview;
5. explicit CLI-authorized, one-time in-memory approval followed by local persist; and
6. local ZIP/hash inspection plus compact JSON/Markdown pilot records.

The runner must fail closed on schema errors, failed capabilities, missing approval flag, hash mismatch, unexpected case IDs, output paths outside its requested local directory, and any public target that no longer matches the locked app/Web Map identity.

## Developer runner

From `dymaxion-runtime`:

```bash
DYMAXION_CONFIG_DIR=../config DYMAXION_WORKSPACE_ROOT=.. \
  npm run pilot:arcgis-change-risk -- \
  --output-dir ../artifacts/arcgis-change-risk-records
```

This previews deterministic evidence bundles and writes compact JSON/Markdown records, but does **not** persist ZIPs. To persist bundles to a trusted pre-existing local artifact root, configure a trusted local execution identity and pass the explicit approval flag:

```bash
mkdir -p ../artifacts/arcgis-change-risk-root
DYMAXION_CONFIG_DIR=../config DYMAXION_WORKSPACE_ROOT=.. \
  DYMAXION_CREDENTIAL_IDENTITIES_JSON='{"export_evidence_bundle":"local-value-pilot-operator"}' \
  npm run pilot:arcgis-change-risk -- \
  --output-dir ../artifacts/arcgis-change-risk-records \
  --artifact-root ../artifacts/arcgis-change-risk-root \
  --approve-persist
```

Do not use Sacramento, authenticated, private, or employer targets. Generated records and ZIP bundles are local artifacts and are not committed.

## Operator change-ticket packet (2026-07-22 enrichment)

The runner's output was enriched into an operator change-ticket packet —
denser Markdown report with structurally distinct observed/derived/
human-entered/unavailable evidence classes, a dependency-map SVG artifact,
an embedded exact rerun command, and an operator-baseline protocol whose
status stays `unavailable` until a human ArcGIS administrator completes it.
Scope stays frozen; no new capability or CLI surface was added. See
[operator-change-ticket-packet.md](operator-change-ticket-packet.md).

## Non-goals

- authenticated/private ArcGIS content;
- production or employer systems;
- reverse dependencies from a service to every consuming app;
- arbitrary Experience Builder, Dashboard, StoryMap, or template parsing;
- contacting feature/map service URLs discovered in item data;
- content mutation, deployment, publication, or notification;
- claiming complete owner/contact coverage;
- adding Phase 2 capability scope before this gate is reviewed.

## Execution sequence

1. Implement and unit-test case validation, report derivation, SVG creation, approval binding, bundle persistence, and output verification.
2. Run typecheck, focused tests, full runtime tests, GISBench, build, smoke, and production audit.
3. Execute all three public cases twice and retain compact records plus locally persisted bundles (generated bundles are not committed).
4. Manually spot-check deterministic samples against public ArcGIS REST item/data responses.
5. Run independent correctness, GIS/product-value, and security reviews; remediate findings.
6. Commit, exact-SHA review, PR, exact-head CI, merge, post-merge CI, and update the Obsidian pilot record.
7. Select the next development slice from measured gaps without pausing for a phase ceremony.
