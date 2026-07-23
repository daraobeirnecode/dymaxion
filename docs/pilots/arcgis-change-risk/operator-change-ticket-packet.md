# ArcGIS change-risk pilot — operator change-ticket packet (locked slice)

**Date:** 2026-07-22<br>
**Branch:** `feat/operator-change-risk-packet`<br>
**Base:** `c8117615c77c462794f30b9992584445c769d3d7`<br>
**Status:** implemented; final-tree local gates and all three locked public
cases verified. Exact-SHA candidate review and release are still pending.

## What this slice is

The 2026-07-22 pilot results concluded that the raw dependency graph contains
the necessary facts but the aggregate findings were too generic for an
operator. This slice enriches the existing pilot runner
(`dymaxion-runtime/src/pilots/arcgis-change-risk-runner.ts`) so its output is
one operator-usable change-ticket packet per locked case, composed only from
the existing `trace_arcgis_dependencies` and `export_evidence_bundle`
capabilities. The original locked pilot added no ninth capability or general
transport surface. The follow-on `arcgis_change_risk_packet` integration now
reuses the same deterministic packet core as a registered **workflow**—still
not a capability—and exposes it through the agent planner/executor, a strict
CLI command, Web/admin, and Telegram.

Report and record schemas are now version `1.1.0` (runner `1.1.0`).

## Packet contents

Each case record's Markdown is a change-ticket report with:

1. locked case/source identity (case, project, organization, portal, root
   Web Mapping Application, Web Map, runner/schema versions);
2. decision summary and explicit review posture (`retirement_cleanup` or
   `change_review`);
3. **observed facts** — values read from `trace_arcgis_dependencies` output,
   each with a source pointer;
4. **derived findings** — deterministic computations, each with its
   derivation rule (including the review-scope band, which remains a
   descriptive proxy, never a risk score);
5. **human-entered facts** — structurally present, schema-locked empty in this
   generated packet version, and explicitly labelled as intentionally empty;
6. **unavailable facts** — machine-readable `status: unavailable` rows,
   always including `authenticated_owner_inventory` and
   `human_operator_baseline` (schema-enforced), plus reverse-dependency
   consumers and live service state;
7. affected dependencies and owners: one row per graph node with `observed`
   (kind, type, title, owner, access, support, depth) and `derived`
   (classification, direct-from-Web-Map, recommended action) sub-objects,
   plus a never-hidden unresolved-reference table;
8. evidence/provenance and integrity identifiers, distinguishing the
   timestamp-neutral structure hash (rerun-comparable) from timestamp-bearing
   report/archive hashes;
9. limitations; and
10. one exact copy-ready shell command that reruns the locked case from
    `dymaxion-runtime` with explicit `DYMAXION_CONFIG_DIR`,
    `DYMAXION_WORKSPACE_ROOT`, the trusted local execution identity label,
    output directory, artifact root, and `--approve-persist`. It contains no
    secret or token placeholder; `local-value-pilot-operator` is an identity
    name, not a credential value.

The four evidence classes are structurally distinct object shapes in the
JSON report (`change_ticket.observed_facts`, `derived_findings`,
`human_entered_facts`, `unavailable_facts`), not prose labels.

## Dependency-map SVG

The bundled artifact is now a deterministic strict SVG dependency map
(replacing the earlier bar summary). One column per trace depth, nodes sorted
by (depth, id), with a readable legend and per-class counts. It visibly
distinguishes and preserves:

- supported item nodes (expanded by the trace);
- unsupported item types (present, not expanded);
- service-reference leaves (recorded, never contacted);
- missing/inaccessible item references; and
- credential-rejected service references (value removed, never dispatched),
  rendered as dashed cells beside their source node together with all other
  unresolved references — nothing unresolved is hidden.

All untrusted text is length-capped and XML-escaped; the closed-primitive
forbidden-construct scan and the export artifact byte ceiling still apply.

## Operator baseline protocol

The packet embeds a short manual protocol (select an approved scenario;
manual review with timing; packet-assisted review with timing and
corrections; ticket-usability judgement; capture results in a separately
reviewed human baseline record—this slice adds no ingestion or editing
surface). Its status is `unavailable` — machine-readable in
`change_ticket.operator_baseline.status` and human-readable in the Markdown —
until a human ArcGIS administrator completes it. No time-saved, usability,
correction-burden, adoption, or customer-value figure is fabricated anywhere
in the packet.

## Shared workflow and delivery

`arcgis_change_risk_packet` accepts only an anonymous ArcGIS Online portal,
a 32-hex root item id, a project UUID, a locked review posture, and an optional
bounded organization label. It runs the trace, renders the exact Markdown/SVG
candidate, previews the deterministic ZIP, requests one post-preview approval
bound to the exact candidate SHA-256 and project target, then consumes that
approval once for persistence. No workflow output exists on disk before the
approval.

On approval it returns exactly three verified attachments:

- `evidence-bundle.zip`;
- `change-ticket.md`; and
- `dependency-map.svg`.

Each attachment carries an opaque project/bundle/entry handle, media type,
SHA-256, and byte count. CLI and Telegram reopen and verify persisted bytes
before delivery. Web emits path-free signed download tokens bound to the same
identity; tokens expire after five minutes. The authenticated admin proxy
forwards only valid tokens to the configured runtime and never exposes local
paths or internal credentials.

Direct CLI usage:

```bash
dymaxion change-risk-packet \
  --portal-url https://example.maps.arcgis.com \
  --root-item-id 0123456789abcdef0123456789abcdef \
  --project-id 00000000-0000-4000-8000-000000000001 \
  --review-posture change_review \
  --organization-name "Example GIS"
```

## Frozen scope

Unchanged from the pilot and still frozen:

- no reverse dependency search;
- no authenticated owner inventory implementation;
- no new ArcGIS item-type parsers or supported JSON paths;
- no ninth native capability;
- no production or preview deployment;
- no controlled writes beyond the existing approved local persist flow;
- no customer-value claim without a human baseline;
- no Sacramento targets; and
- generated local `artifacts/` outputs stay out of git.

Existing approval/persistence behavior, item-provided-service-URL
never-dispatch guarantees, credential-path rejection/non-echo behavior, and
manifest lower-bound (never exact-total) reference-count checks are
preserved exactly. Direct reference counts remain observed values checked
against manifest lower bounds.

## Verification

Final-tree verification used exact Node `22.23.1`:

```bash
npx -y node@22.23.1 ./node_modules/typescript/bin/tsc --noEmit
npx -y node@22.23.1 ./node_modules/tsx/dist/cli.mjs --test test/arcgis-change-risk-runner.test.ts test/trace-arcgis-dependencies.test.ts
npx -y node@22.23.1 ./node_modules/tsx/dist/cli.mjs --test test/*.test.ts
npx -y node@22.23.1 ./node_modules/tsx/dist/cli.mjs src/gisbench/run.ts
npx -y node@22.23.1 ./node_modules/typescript/bin/tsc
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills npx -y node@22.23.1 dist/main.js smoke-test
```

Results: focused `39/39`, runtime `223/223`, GISBench `40/40`, admin `2/2`,
Windows worker `6/6`, runtime/admin/worker builds and smoke passed, and all
three production dependency audits reported zero vulnerabilities. Packet
tests use committed synthetic fixtures; the separate post-test public run
queried only the three approved anonymous ArcGIS Online cases and persisted
ignored local evidence. Independent verification confirmed exact ZIP member
hashes, preview/persist byte and SHA-256 equality, embedded trace provenance,
public approvals `[]`, unavailable human baselines, never-dispatched service
leaves, and byte-exact Markdown re-rendering from each canonical machine
record. Rasterized visual inspection passed for all three SVG maps.
