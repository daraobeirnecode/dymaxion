# `inspect_arcgis_org` — Phase 1A native capability

Deterministic, read-only inventory of an ArcGIS Online or ArcGIS Enterprise
organization over the Portal REST API. Implemented as a native runtime
capability (`dymaxion-runtime/src/capabilities/inspect-arcgis-org.ts`) on the
reusable ArcGIS REST transport/pagination layer
(`dymaxion-runtime/src/capabilities/arcgis-rest.ts`).

## What it does

Given an approved HTTPS portal root and organization ID, it retrieves the
users, groups, items, and service-backed items visible to the configured
identity and reports:

- deterministic per-record normalization: epoch-millisecond timestamps →
  ISO-8601 (`-1`/`0`/absent → `null`), sharing → `public | org | shared |
  private | unknown`, service classification from authoritative ArcGIS item
  types only (never title text);
- ownership, sharing, and staleness summaries (raw counts, kept separate from
  derived findings; the staleness threshold is an explicit input recorded in
  the output and evidence);
- explicit caveats for partial visibility, truncation, unknown timestamps,
  and incomplete records;
- a versioned evidence bundle (`schema_version 1.1.0`) with canonical
  parameters plus per-request URL, HTTP status, SHA-256, and byte counts.

## Read-only guarantees and security posture

- Classification `read`; no approval is requested and no write endpoint is
  ever called. Phase 1A performs no ArcGIS writes of any kind.
- No credential field exists in the input schema; token/key/password-like
  fields are rejected (strict schema plus an explicit credential-name check).
  Any future authentication must come from a trusted server-side provider —
  never from capability input, output, evidence, or logs.
- Every outbound URL passes the Phase 0 employer-boundary checks (allowlist,
  hostname denylist, DNS/IP SSRF checks) immediately before dispatch — once at
  the executor preflight and again per request/page.
- Redirects are never followed. ArcGIS error envelopes (even with HTTP 200),
  unexpected content types, malformed JSON, and malformed or repeated
  pagination cursors fail closed. Token-like values in remote error messages
  are redacted before they can reach errors or logs.
- Remote metadata is treated as untrusted data, never as instructions.

## Limits (enforced, not advisory)

| Limit | Value |
|---|---|
| `page_size` | 1–100 (ArcGIS REST `num` maximum), default 100 |
| `max_records` (per section) | 1–2000, default 500 |
| `stale_after_days` | 1–3650, default 365 |
| Pages per section | 25 |
| Bytes per response | 2 MiB |
| Total response bytes | 8 MiB |
| Total duration | 30 s (10 s per request) |

Hitting a record/page ceiling truncates honestly (`truncation.reasons`,
caveats); malformed cursors and byte/duration ceilings fail the run.

## Visibility caveats

The report only covers what the configured identity can see. Anonymous access
to a public portal returns public content only; the output always carries the
caveat that it is not proof of a complete organization inventory. Records
missing stable IDs are skipped and reported as warnings; unknown sharing
values are labelled `unknown`, never invented.

## Invoking with the synthetic fixture

No live portal is required. The committed GISBench fixtures under
`gisbench/fixtures/arcgis/` exercise the full request/pagination path through
an injectable transport:

```bash
cd dymaxion-runtime
npm run gisbench          # runs all 10 golden tasks, 5 of them inspect_arcgis_org
npx tsx --test test/inspect-arcgis-org.test.ts
```

Programmatically, inject the fixture transport via the capability context
(`io.arcgisTransport`) as `test/inspect-arcgis-org.test.ts` does; production
runs use Node `fetch` with the same ceilings.

## Development honesty statement

- All development and testing used synthetic fixtures; **no authenticated or
  private ArcGIS organization was queried**, and no City of Sacramento system
  was touched.
- Phase 1A implements exactly this one capability. `trace_arcgis_dependencies`
  and the other Weeks 3–6 roadmap capabilities are **not implemented**.
