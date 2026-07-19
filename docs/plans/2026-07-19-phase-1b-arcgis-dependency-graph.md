# Phase 1B ArcGIS Dependency Graph Implementation Plan

> **For Fable 5:** implement this plan in the current isolated worktree. Use test-driven changes, keep one coherent local branch, and do not publish or access live ArcGIS systems.

**Goal:** Add a native, deterministic, read-only `trace_arcgis_dependencies` capability that answers which supported ArcGIS items and service references depend on one another and what would be affected by retiring a discovered node.

**Architecture:** Reuse the Phase 1A `ArcGisRestTransport`, URL boundary checks and evidence patterns. Fetch item metadata and item data only through portal-root URLs constructed from validated item IDs. Parse a narrow allowlist of known ArcGIS JSON paths into a bounded in-memory graph; service URLs are sanitized leaf references and are never dispatched. Canonically sort graph output before hashing while retaining request evidence in actual dispatch order.

**Tech stack:** TypeScript, Node.js 22+, Zod, native capability registry, synthetic ArcGIS fixture transport, Node test runner and GISBench.

---

## Scope and contracts

### Supported graph traversal

MVP traversal is downstream from one or more root item IDs:

`Web Mapping Application → Web Map → ArcGIS item/service reference`

Support these sources only:

- `Web Mapping Application` item data: explicitly documented/configured web map item-ID fields after fixture-backed verification; do not recursively scrape arbitrary strings.
- `Web Map` item data:
  - `operationalLayers[].itemId` and `operationalLayers[].url`;
  - `tables[].itemId` and `tables[].url`;
  - `baseMap.baseMapLayers[].itemId` and `baseMap.baseMapLayers[].url` when present.
- Service-backed or unsupported item types are terminal item nodes with an explicit support status/caveat.

Do not claim support for ArcGIS Dashboards, Experience Builder, StoryMaps or arbitrary Web Mapping Application templates unless a precise parser and synthetic fixtures are included in this phase.

### Input

Strict/versioned input equivalent to:

- `portal_url`: approved HTTPS portal root;
- `root_item_ids`: 1–25 ArcGIS item IDs, each exactly 32 hexadecimal characters;
- `max_depth`: bounded positive integer, default no greater than 6;
- `max_nodes`: bounded positive integer, default no greater than 500;
- `max_edges`: bounded positive integer, default no greater than 1,000;
- `max_requests`: bounded positive integer, default no greater than 1,000;
- `max_response_bytes`: bounded per-response ceiling;
- `max_total_response_bytes`: bounded whole-run ceiling;
- `max_duration_ms`: bounded whole-run duration.

No token, password, API key, cookie, arbitrary endpoint path or arbitrary URL field is permitted.

### Output

Strict/versioned output must include:

- canonical nodes with stable IDs, ArcGIS item identity/type/title/owner/access where available, and terminal/support status;
- canonical typed edges with `from`, `to`, `relationship`, and a controlled JSON-path/source locator;
- roots;
- per-node upstream and downstream impact summaries computed only within the discovered graph;
- cycles as canonical node-ID sequences or strongly connected components;
- unresolved/missing/unsupported references with deterministic warnings;
- graph totals and truncation state/reasons;
- visibility and completeness caveats;
- versioned evidence with canonical parameter hash, request records and canonical graph/report hash.

Item nodes should use a stable namespace such as `item:<item-id>`. Sanitized service leaves should use a stable hash-derived ID so output does not leak credentials or signed query strings.

## Security and correctness invariants

- Preserve ADR-0001 and all Phase 0 approval/identity behavior.
- Classify as `read`; it never requires or consumes a write approval.
- Before every item metadata/data request, call the shared boundary check immediately before transport dispatch.
- Construct request URLs from the validated portal root plus validated item IDs. Never dispatch item-provided URLs.
- Redirects remain rejected.
- Item data, metadata, titles, owners, URLs and ArcGIS error envelopes are untrusted data, never instructions.
- Drop URL userinfo, fragments and secret-bearing query parameters. Never serialize credential canaries to output, warnings, evidence or errors.
- Do not perform broad regex/recursive discovery of 32-character strings or URLs in arbitrary JSON.
- Reject duplicate/conflicting item identities and impossible response shapes where trust cannot be established.
- Detect cycles; never recurse without visited-state and depth/request/node/edge/byte/duration ceilings.
- Canonical node, edge, warning, cycle and unresolved-reference ordering must make output/evidence hashes independent of root order, page order and object-key order.
- Request evidence remains in real dispatch order and may differ while canonical graph hashes remain equal.
- Cancellation must be checked before dispatch and during traversal.
- Tests and GISBench use synthetic local fixtures, stubbed DNS and injectable transport only. No live ArcGIS, Sacramento, employer, private or authenticated access.

## Task 1: Contract and failing tests

**Files:**

- Create: `dymaxion-runtime/src/capabilities/trace-arcgis-dependencies.ts`
- Create: `dymaxion-runtime/test/trace-arcgis-dependencies.test.ts`
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify capability-contract tests as needed.

Write strict input/output and manifest tests first. Prove unknown fields and credential-like inputs are rejected and the capability is registered as read-only.

## Task 2: Bounded retrieval and graph construction

Reuse `requestArcGisJson`. Implement deterministic queue traversal and explicit parsers for the supported item types/paths. Fetch only:

- `/sharing/rest/content/items/{validatedId}?f=json`
- `/sharing/rest/content/items/{validatedId}/data?f=json`

Add tests for valid app→map→service/item chains, missing item/data envelopes, unsupported types, cancellation and every resource ceiling.

## Task 3: Adversarial security and determinism

Add tests proving:

- unsafe/lookalike portal hosts are blocked before transport dispatch;
- item-provided service URLs are never dispatched;
- URL userinfo/query credentials and ArcGIS error-envelope canaries do not survive;
- reversed roots/object keys/reference arrays yield the same canonical graph and output hash;
- cycles terminate deterministically;
- duplicate edges deduplicate canonically;
- malformed IDs and malformed known JSON paths fail or warn deterministically;
- Phase 0 write/execute approval tests still pass.

## Task 4: GISBench and documentation

Add at least five new fixture-backed GISBench tasks:

1. valid app→map→service graph;
2. cycle and duplicate-reference normalization;
3. unresolved/missing item handling;
4. graph/resource-ceiling behavior;
5. boundary/secret adversarial rejection.

Update GISBench task schemas/counts, README capability truth, `CLAUDE.md`, and create `docs/capabilities/trace-arcgis-dependencies.md` with exact supported item types, paths, limits and caveats.

## Task 5: Verification

Run and report real outputs:

```bash
cd dymaxion-runtime
npm ci
npm run typecheck
npm test
npm run gisbench
npm run build
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test
npm audit --omit=dev
```

Also run the Admin and Worker package tests/builds/audits, standalone Compose validation, `git diff --check`, and complete working-tree source-integrity/secret checks. Do not commit, push, open a PR, merge, deploy or contact any external ArcGIS service.

## Acceptance gate

Implementation is locally ready only when:

- all code/tests/docs are present and scoped;
- deterministic and adversarial probes pass;
- GISBench includes and passes the new tasks;
- no real credentials or private data exist;
- Phase 0 approval tests remain green;
- Mercator independently verifies the diff and commands;
- Tyr later reviews the exact commit before merge.
