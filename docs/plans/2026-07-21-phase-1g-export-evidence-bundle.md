# Phase 1G `export_evidence_bundle` Implementation Plan

> **For Hermes:** Use subagent-driven-development to implement this plan task-by-task, but keep all release commits with the controller. Subagents must not commit, stage, push, run live GIS, or edit outside the files named by their task.

**Goal:** Add deterministic approval-bound evidence-bundle export with project-scoped durable artifact storage and a reproducible ZIP archive containing `manifest.json`, `report.json`, `evidence.json`, and exactly one generated UTF-8 SVG or GeoJSON artifact.

**Architecture:** `export_evidence_bundle` is a native `copy-on-write` capability with operation-aware approval: `preview` canonicalizes and hashes the exact archive without writes or approvals; `persist` recomputes the same archive, requires the caller's preview `target_bundle_sha256`, consumes a one-time approval receipt bound to the exact project/hash target, and publishes `bundle.zip` idempotently under the trusted project artifact root. The deterministic ZIP writer uses STORE entries only, fixed DOS timestamp `1980-01-01T00:00:00`, fixed entry order/permissions/UTF-8 flags/CRC32, no compression package, and strict size/count limits. The storage sink accepts no caller path and reasserts trusted-root containment, symlink rejection, create-only/idempotent publication, quotas, per-project locking, and read-back hash verification before success.

**Tech stack:** TypeScript/Node.js 22, Zod, existing canonical JSON/SHA-256/evidence/capability/approval contracts, Node `fs` primitives, no new npm dependency, official GISBench only.

---

## Repository and scope guard

- Worktree: `/Users/calmadmin/.hermes/profiles/mercator/worktrees/dymaxion-phase1g`
- Base HEAD: `8947f2e501ada474e727e7182a691e8eec37a263`
- Branch: `feat/phase-1g-export-evidence-bundle`
- Implementers may edit implementation/tests/docs named below, but this planning subagent edits only this file.
- No Postgres/S3, raw-source export, compression, encryption/signing, multiple artifacts, deletion/rollback, remote storage, broader vector operations, live GIS, network fetches, package install, staging, commits or pushes.

## Key architecture corrections to enforce

1. **Preview and persisted archive bytes must be identical.** Approval facts cannot be inserted into the ZIP `evidence.json` on `persist`, because that would change the archive hash from the preview target. Therefore:
   - ZIP entry `evidence.json` is the strict upstream `EvidenceBundle` supplied in input and is canonicalized identically for preview and persist.
   - Capability response `export_evidence` is a separate EvidenceBundle for the export operation with `approvals = []` for both preview and persist. Approval authority remains in the approval subsystem and audit record; the output schema rejects injected unsigned approval claims rather than presenting them as independently authentic. `export_evidence` is not a ZIP entry.
2. **No circular manifest hash.** `manifest.json` must not contain `archive_sha256`, `archive.bytes`, or its own entry hash/byte count. Its single canonical `entries` object gives path/media type only for `manifest.json`, and exact hashes/bytes for `report.json`, `evidence.json`, and the generated artifact. Put the archive SHA-256/bytes only in the capability response and opaque handle.
3. **`copy-on-write` must not mean every operation requires approval.** Add one shared operation-aware approval hook and use it in both `agent/planner.ts` and `skills/executor.ts`: `preview` is non-approval, `persist` is approval-required.
4. **Approval must be unforgeable at the write sink.** `consumeApproval()` returns an in-process branded receipt; the registry claims it once into a one-shot execution grant, and the capability consumes that grant before storage. `persist` fails through `runSkill`, exported `executeCapability()`, or direct exported capability `.execute()` without genuine authorization whose facts verify against agent run, canonical payload hash, target and credential identity.
5. **Output schema cannot prove persisted bytes by itself.** The persisted response may report `read_back_verified: true`, but only because execution reads the published file back and recomputes bytes/hash before returning. Document this honestly.

## Locked MVP contract

### Input schema `1.0.0` strict

```ts
{
  operation: 'preview' | 'persist';
  project_id: '<uuid-v4-or-rfc4122-uuid>';
  bundle_slug: '<safe lower-case slug, 1..80 chars>';
  report: JsonValue;             // canonical UTF-8 <= 1 MiB, depth <= 32, nodes <= 20k
  evidence: EvidenceBundle;       // canonical UTF-8 <= 1 MiB, strict existing schema
  artifact: {
    output_name: '<safe evidence output name>';
    file_name: '<safe basename ending .svg or .geojson>';
    media_type: 'image/svg+xml; charset=utf-8' | 'application/geo+json; charset=utf-8';
    content: string;              // exact UTF-8 <= 2 MiB
  };
  target_bundle_sha256?: '<64 lowercase hex>'; // required only for persist
}
```

Validation rules:

- Unknown fields reject everywhere.
- `project_id` is used only as a storage namespace and approval target component; it is never used to construct an unchecked caller path.
- `bundle_slug`, `artifact.output_name`, and `artifact.file_name` reject controls, slash/backslash, `..`, leading dot, Windows drive/UNC forms, percent-encoded path separators, shell metacharacter ambiguity, and credential-shaped material.
- `artifact.file_name` extension and media type must agree exactly: `.svg` with `image/svg+xml; charset=utf-8`; `.geojson` with `application/geo+json; charset=utf-8`.
- Artifact content must round-trip exactly through UTF-8 encode plus fatal decode (reject lone/unpaired surrogate strings such as `\uD800`), must be <= 2,097,152 bytes, and must not be accepted as bytes/base64/path/URL.
- `evidence.outputs` must contain exactly one output whose `name === artifact.output_name`, `sha256 === sha256Text(artifact.content)`, and `bytes === Buffer.byteLength(artifact.content, 'utf8')`; mismatches reject before approval or write.
- Archive entries are exactly four and in this exact order: `manifest.json`, `report.json`, `evidence.json`, `artifact.file_name`.
- Final ZIP must be <= 5,242,880 bytes. No ZIP64.

### Preview behavior

- Parse input, canonicalize report/evidence/manifest, build deterministic ZIP bytes, compute archive SHA-256/bytes, and return handle `artifact://project/<project_id>/bundle/<archive_sha256>`.
- Do not request approval, consume approval, create directories, open/write/link files, or call storage.
- If `target_bundle_sha256` is provided on preview, reject as unknown/inapplicable unless the schema models it as optional with a super-refine error: `target_bundle_sha256 is only valid for persist`.

### Persist behavior

- Require `target_bundle_sha256` from a prior preview.
- Recompute archive bytes from the current input before any write.
- If recomputed SHA-256 differs from `target_bundle_sha256`, fail before approval consumption and before storage with a fixed `target_bundle_sha256 mismatch` error.
- Approval target is exactly `capability:export_evidence_bundle|project:<uuid>|bundle:<target_bundle_sha256>`.
- Approval credential identity comes from `resolveExecutionCredentialIdentity('export_evidence_bundle')`, backed by operator-controlled `DYMAXION_CREDENTIAL_IDENTITIES_JSON`; it is never model input or a caller field. Missing/malformed configuration fails closed before approval or write.
- After genuine approval receipt verification, publish create-only/idempotently at trusted production path:
  `<DYMAXION_WORKSPACE_ROOT or /workspace>/projects/<uuid>/artifacts/<sha256>/bundle.zip`.
- If target exists, read and verify exact bytes/hash and return `persisted: true`, `created: false`; never overwrite.
- If created, write temp with `O_CREAT|O_EXCL|O_NOFOLLOW`, fsync file, close, hard-link to final target atomically, fsync containing directory where supported, clean temp, read final bytes back, verify bytes/hash, then return `persisted: true`, `created: true`.

### Output schema `1.0.0` strict

Use a discriminated or consistent strict schema; prefer consistent shape for simpler GISBench normalization:

```ts
{
  schema_version: '1.0.0';
  operation: 'preview' | 'persist';
  persisted: boolean;
  created: boolean;
  handle: `artifact://project/${string}/bundle/${string}`;
  archive: {
    media_type: 'application/zip';
    sha256: string;
    bytes: number;
    entries: 4;
    zip_profile: 'store-fixed-1980-utf8-crc32-v1';
    read_back_verified: boolean; // false for preview, true after persist storage verification
  };
  manifest: BundleManifest;
  export_report: ExportBundleReport;     // bounded summary, no raw source data
  export_evidence: EvidenceBundle;       // export operation evidence; approvals always empty
}
```

`preview`: `persisted=false`, `created=false`, `archive.read_back_verified=false`, `export_evidence.approvals=[]`.

`persist`: `persisted=true`, `created` reflects new vs idempotent existing, `archive.read_back_verified=true`, and `export_evidence.approvals=[]`; consumed approval facts remain authoritative in the approval subsystem/audit record rather than being serialized as unsigned response claims.

### Exact `export_evidence` construction

`buildExportEvidence(...)` must return a strict `EvidenceBundleSchema` value with these bindings:

- `schema_version: '1.0.0'`; `bundle_id: 'export_evidence_bundle:' + archive.sha256`; `generated_at` and `source.retrieved_at` use the same injected deterministic wall clock.
- `source` commits the canonical upstream `evidence.json` bytes: URI `dymaxion:inline-evidence:<upstream-evidence-sha256>`, identity `{kind:'inline-evidence',value:<upstream-evidence-sha256>}`, empty `version`, exact SHA-256 and byte count. It never invents a filesystem or network source.
- `gis_metadata` is `{format:'Dymaxion evidence bundle',crs:null,axis_order:null,units:null,extent:null,schema:[],row_count:1,geometry_types:[],temporal_fields:[]}`.
- `parameters.canonical_json` is canonical JSON over only bounded replay facts: operation, project ID, bundle slug, report hash/bytes, upstream evidence hash/bytes, artifact output name/file/media/hash/bytes, and target bundle SHA when present. `parameters.sha256` is the exact text hash of that canonical JSON.
- `execution` is `{capability:'export_evidence_bundle',capability_version:'1.0.0',mode:'deterministic',model_planning:[]}`.
- `outputs` has exactly one `evidence_bundle_zip` entry bound to the actual archive SHA-256/bytes. Validation checks include deterministic ZIP profile and entry-integrity verification; persist additionally includes storage read-back verification.
- `approvals` is empty for preview and persist. The output schema rejects any injected approval object; exact receipt, payload hash, target, identity, operator and timestamp remain in the approval subsystem/audit record.
- `rollback` is always `{required:false,strategy:'none',artifacts:[]}` because this slice is create-only and implements no deletion/rollback.

The capability output schema must independently cross-bind the report, manifest, archive and export-evidence duplicate claims. Focused mutation tests must alter each duplicate claim separately and prove rejection. Persisted bytes themselves are authenticated by sink read-back, not by response-schema shape alone.

## Resource limits and manifest constants

- Report canonical UTF-8 bytes: 1,048,576
- Evidence canonical UTF-8 bytes: 1,048,576
- Artifact UTF-8 bytes: 2,097,152
- Archive bytes: 5,242,880
- Archive entries: exactly 4
- JSON depth: 32
- JSON nodes: 20,000
- Per-project storage: 64 MiB and 100 bundles
- Duration: 5,000 ms with cancellation/deadline checkpoints before/after validation, before ZIP build, before approval verify, before storage, during project quota scan, before temp write, after temp write, before/after read-back
- Output summary fields: bounded; no unbounded echo of report/evidence/artifact content outside the explicitly returned report/evidence objects

## Task dependencies

1. `discovery/contracts` must land first because approval hook, receipt types, manifest limit fields and schemas are shared by all later tasks.
2. `storage+ZIP` depends on constants and contracts but not on registry integration.
3. `capability+approval receipt` depends on both prior tasks.
4. `integration/GISBench/docs` depends on the capability being executable through `runSkill()` with injected approval/storage dependencies.
5. `release/review` runs only after all previous GREEN checks pass and no unauthorized files changed.

---

## Controller Todo 1: discovery/contracts

### Task 1.1: Add explicit resource-limit contract fields

**Objective:** Make Phase 1G hard ceilings visible in strict manifests without weakening existing manifests.

**Files:**
- Modify: `dymaxion-runtime/src/contracts/capability.ts`
- Modify: `dymaxion-runtime/test/contracts.test.ts`

**RED:** Add failing tests in `contracts.test.ts` proving `CapabilityManifestSchema` accepts these optional positive integers and rejects zero/fractional/unknown fields:

- `max_report_bytes`
- `max_evidence_bytes`
- `max_artifact_bytes`
- `max_archive_bytes`
- `max_archive_entries`
- `max_project_bytes`
- `max_project_bundles`

Run:

```bash
cd /Users/calmadmin/.hermes/profiles/mercator/worktrees/dymaxion-phase1g/dymaxion-runtime
npm run test:contracts
```

Expected RED: FAIL with Zod `unrecognized_keys` or missing accepted fields for the new optional limits.

**GREEN:** Add the optional fields to `CapabilityManifestSchema.resource_limits` as `z.number().int().positive().optional()`. Keep `.strict()`.

Run:

```bash
npm run test:contracts
```

Expected GREEN: PASS for contract tests, including old manifest unchanged.

### Task 1.2: Define approval requirements and branded receipts

**Objective:** Preserve existing approval record facts while making write authorization unforgeable inside the process.

**Files:**
- Modify: `dymaxion-runtime/src/security/approval.ts`
- Modify: `dymaxion-runtime/test/approval.test.ts`

**Implementation shape:**

- Use `ConsumedApprovalReceipt` for the opaque frozen receipt returned by `consumeApproval(...)` and `ConsumedApprovalExecutionGrant` for the opaque one-execution handoff from the registry to the capability sink.
- In `approval.ts`, retain module-local WeakSet/WeakMap provenance for genuine receipts, claimed receipts, grants, and used grants; neither object is authenticated by shape alone.
- Change `consumeApproval(...)` return type from `Promise<ApprovalRecord>` to `Promise<ConsumedApprovalReceipt>`.
- Export:
  - `verifyConsumedApprovalReceipt(receipt, exactBinding): ConsumedApprovalSnapshot`
  - `claimConsumedApprovalReceipt(receipt, exactBinding): ConsumedApprovalExecutionGrant`
  - `verifyConsumedApprovalExecutionGrant(grant, exactBinding): ConsumedApprovalSnapshot`
- Receipt verification must bind `agentRunId`, `payload_hash === sha256Canonical(payload)`, the exact target derived from `skill` plus that payload, configured credential identity, and decision `approved`. Claiming a receipt and consuming its execution grant at capability entry are each one-shot. After consumption, each storage sink may non-consumptively revalidate the same genuine grant against the identical binding.
- Keep existing `createApprovalRequest`, `decideApproval`, `awaitDecision`, `InMemoryApprovalStore`, and DB facts semantically unchanged.

**RED:** Extend `approval.test.ts`:

1. Existing successful `consumeApproval` returns a genuine frozen receipt snapshot.
2. `verifyConsumedApprovalReceipt(receipt, exactBinding)` returns reviewed facts.
3. Forged receipt and grant objects throw.
4. A receipt can be claimed once, its execution grant can be consumed once at capability entry, and that consumed grant can then be revalidated repeatedly at storage sinks.
5. Reusing a consumed request still fails; binding mismatches still fail.

Run:

```bash
npm test -- --test-name-pattern='approval'
```

Expected RED: FAIL because helpers/receipt type do not exist and old return type is record.

**GREEN:** Implement the receipt helpers and update tests.

Run:

```bash
npm test -- --test-name-pattern='approval'
npm run typecheck
```

Expected checkpoint: approval tests pass. The receipt contract intentionally leaves caller updates RED until Task 1.3; do **not** label Todo 1 green or run its review gate until Task 1.3 restores a clean `npm run typecheck`.

### Task 1.3: Add shared operation-aware approval hook to capability contracts

**Objective:** Make planner and executor agree on preview vs persist approval without duplicating operation-specific logic.

**Files:**
- Modify: `dymaxion-runtime/src/contracts/capability.ts`
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify: `dymaxion-runtime/src/skills/executor.ts`
- Modify: `dymaxion-runtime/src/agent/planner.ts`
- Modify: `dymaxion-runtime/src/agent/executor.ts`
- Modify: `dymaxion-runtime/test/executor-approval.test.ts`
- Modify: `dymaxion-runtime/test/approval.test.ts` if helper tests belong there

**Implementation shape:**

- Extend `CapabilityDefinition` with one optional pure policy hook:

```ts
requiresApproval?(input: TInput): boolean;
```

- Add shared `capabilityRequiresApproval(capability, input)` handling that accepts either raw input or an explicit `{ alreadyParsed: true, parsedInput }` form. It must parse exactly once when input is raw, call the hook when present, and otherwise preserve the fail-closed default `classification !== 'read'`.
- This phase deliberately does **not** introduce a second richer `ApprovalRequirement` API. For every native capability, the exact schema-parsed input object is the single canonical approval payload. Target is always `deriveApprovalTarget(slug, parsedInput)` and credential identity is always `resolveExecutionCredentialIdentity(slug)`.

Rules:

- Unknown capabilities fail closed.
- Input is schema-parsed before the hook or any approval request.
- If parse fails in planner, preserve existing fail-closed behavior by treating non-read capability as destructive.
- `preview` and `persist` differ only through the capability's pure boolean hook; payload, target, and identity derivation are centralized and identical everywhere else.

Executor changes:

- `RunSkillDependencies` accepts `approvalDependencies?: ApprovalDependencies` and `approvalRequest?: ApprovalRequest`.
- `runSkill()` parses native input, runs shared boundary and capability preflight, then evaluates `capabilityRequiresApproval(..., { alreadyParsed: true, parsedInput })`.
- If approval is required, consume it against the exact parsed input, `deriveApprovalTarget(slug, parsedInput)`, and `resolveExecutionCredentialIdentity(slug)`, passing injected approval dependencies.
- Put the returned `ConsumedApprovalReceipt` into `dependencies.capabilityContext.approvalReceipt` before `executeCapability()`.
- Historical non-capability skills keep existing behavior, but use the new receipt return only for validation; they need not pass a receipt to subprocess skills.

Agent changes:

- `planner.ts` must mark native plan steps destructive using the same `capabilityRequiresApproval` hook when input parses; if parsing fails, preserve existing fail-closed non-read behavior.
- `agent/executor.ts` and `replayRun()` must schema-parse native step input before request creation, then create requests from that exact parsed payload using `deriveApprovalTarget(slug, parsedInput)` and `resolveExecutionCredentialIdentity(slug)`. `runSkill()` must receive the same logical input and re-derive identical binding facts.
- Historical skills continue to use their existing input with `deriveApprovalTarget()` and `resolveExecutionCredentialIdentity()`.

**RED:** Extend `executor-approval.test.ts` with a synthetic registered native capability or use `export_evidence_bundle` once added later. Prove the existing direct destructive skill rejection still happens before invocation persistence and add operation-aware tests for `capabilityRequiresApproval`; defer export-specific cases to Task 3.2.

Run:

```bash
npm test -- --test-name-pattern='approval|shared dispatcher'
npm run typecheck
```

Expected GREEN after implementation: approval and executor approval tests pass; typecheck passes.

**Review gate 1:** Before moving on, run:

```bash
git diff -- dymaxion-runtime/src/contracts/capability.ts dymaxion-runtime/src/security/approval.ts dymaxion-runtime/src/capabilities/registry.ts dymaxion-runtime/src/skills/executor.ts dymaxion-runtime/src/agent/planner.ts dymaxion-runtime/src/agent/executor.ts dymaxion-runtime/test/approval.test.ts dymaxion-runtime/test/executor-approval.test.ts
npm run typecheck
npm test -- --test-name-pattern='approval|shared dispatcher|contracts'
```

Expected: only intended files changed; commands pass.

---

## Controller Todo 2: storage+ZIP

### Task 2.1: Implement deterministic ZIP STORE writer

**Objective:** Produce byte-identical ZIP archives without new packages.

**Files:**
- Create: `dymaxion-runtime/src/capabilities/deterministic-zip.ts`
- Create: `dymaxion-runtime/test/deterministic-zip.test.ts`

**ZIP profile:** `store-fixed-1980-utf8-crc32-v1`

Implementation requirements:

- Input entries: array length 1..4, caller-supplied order retained.
- Entry name validation: UTF-8 string, no empty name, no leading `/`, no drive/UNC, no `..`, no backslash, no duplicate names, max 255 UTF-8 bytes.
- Method: STORE (`compression method = 0`), no data descriptor, no encryption.
- General purpose bit flag: UTF-8 names (`0x0800`) only.
- DOS time/date: time `0x0000`, date `0x0021` (1980-01-01).
- External attributes inside the deterministic ZIP: regular file mode `0100644 << 16`; version made by Unix if implemented. This is archive metadata only. On-disk temp and `bundle.zip` storage files use restrictive mode `0600` where supported; storage mode is not part of archive-byte determinism.
- CRC32: implement table-based IEEE CRC32 locally; output unsigned little-endian.
- Offsets/sizes: reject if any offset/size exceeds 32-bit ZIP fields; no ZIP64.
- Archive cap: caller passes max bytes and writer throws before returning if exceeded.

**RED tests:**

1. Same entries produce identical bytes and SHA-256 across repeated calls.
2. Reordering entries changes hash.
3. Parser written in the test reads local headers + central directory and asserts method, timestamp, UTF-8 flag, CRC32, sizes, permissions, and EOCD count.
4. Duplicate/unsafe names and archive cap reject.
5. CRC changes when content changes.

Run:

```bash
npm test -- test/deterministic-zip.test.ts
```

Expected RED: FAIL because file/module does not exist.

**GREEN:** Implement minimal writer and parser test helper. Do not import ZIP packages.

Run:

```bash
npm test -- test/deterministic-zip.test.ts
npm run typecheck
```

Expected: deterministic ZIP tests pass; typecheck passes.

### Task 2.2: Implement project-scoped durable artifact storage

**Objective:** Publish exact ZIP bytes under trusted project scope with create-only/idempotent semantics and read-back verification.

**Files:**
- Create: `dymaxion-runtime/src/capabilities/artifact-storage.ts`
- Create: `dymaxion-runtime/test/artifact-storage.test.ts`

**Production root:**

```ts
const workspaceRoot = process.env.DYMAXION_WORKSPACE_ROOT ?? '/workspace';
const target = `${workspaceRoot}/projects/${projectId}/artifacts/${sha256}/bundle.zip`;
```

Never accept a caller path. The only caller-controlled path components are already-validated UUID and lowercase SHA-256.

**Interface:**

```ts
export interface ArtifactStorage {
  publishBundle(input: {
    projectId: string;
    sha256: string;
    bytes: Uint8Array;
    signal?: AbortSignal;
  }): Promise<{ handle: string; created: boolean; bytes: number; sha256: string; readBackVerified: true }>;
}

export function createFileArtifactStorage(options?: {
  workspaceRoot?: string;
  maxProjectBytes?: number;
  maxProjectBundles?: number;
}): ArtifactStorage;
```

Implementation requirements:

- Per-project in-process lock: serialize publishes for the same `projectId` using a `Map<string, Promise<unknown>>` queue and clean finished locks.
- Production container default is `/workspace`; local/dev/test execution must inject or explicitly set `DYMAXION_WORKSPACE_ROOT` to a pre-existing trusted directory. Tests always use temp roots and never create or use host `/workspace` implicitly.
- Trusted root must pre-exist, be a real non-symlink directory, and pass `realpath` containment checks; storage must not recursively create the trusted root.
- For each component `projects`, `<uuid>`, `artifacts`, `<sha256>`: if exists, `lstat` and reject symlink/non-directory; if missing, `mkdir` with restrictive mode; after creation, `realpath` and assert containment under root.
- Reject if any pre-existing component is symlink, file, FIFO, socket, or escapes root after realpath.
- Quotas under `<root>/projects/<uuid>/artifacts`: count only valid 64-hex directories with `bundle.zip`; reject malformed non-directory artifacts if they would make quota ambiguous. Enforce max 100 bundles and max 64 MiB total after considering this bundle. Existing exact target is idempotent and may return before quota rejection if bytes/hash match.
- Existing target and every quota/read-back inspection: `lstat` final `bundle.zip` and reject symlink/non-regular files before reading; open with `O_RDONLY|O_NOFOLLOW` where supported, `fstat` the opened descriptor as regular, read through that descriptor with an exact bound, then verify byte length, SHA-256 and bytes. The quota scan applies the same no-follow rule. Exact match returns `created:false`; any mismatch throws fixed `artifact content-address collision` without overwrite.
- New target: write temp file in the target directory with randomized suffix using `open(..., O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)`, write all bytes, fsync, close, hard-link temp to `bundle.zip`, fsync directory where supported, unlink temp in `finally`.
- If hard-link fails because target appeared, verify existing exact bytes/hash and return idempotent existing.
- Always read back final `bundle.zip` and verify exact bytes/hash before returning success.
- Do not return filesystem path in public output; tests may inspect temp root directly.

**RED tests:**

1. New publish creates `projects/<uuid>/artifacts/<sha>/bundle.zip` under injected temp root and returns handle.
2. Second identical publish returns `created:false` and does not overwrite.
3. Existing mismatched target rejects.
4. Symlinked `projects`, project, `artifacts`, hash dir, or `bundle.zip` path rejects.
5. Path escape is impossible even with malicious project/hash test values because schema rejects before storage; storage still validates UUID/SHA and rejects invalid direct calls.
6. Quota rejects 101st bundle and >64 MiB total.
7. Concurrent same-project publishes serialize and all return exact bytes.

Run:

```bash
npm test -- test/artifact-storage.test.ts
```

Expected RED: FAIL because storage module does not exist.

**GREEN:** Implement storage adapter.

Run:

```bash
npm test -- test/artifact-storage.test.ts
npm run typecheck
```

Expected: storage tests pass; typecheck passes.

**Review gate 2:** Run:

```bash
npm test -- test/deterministic-zip.test.ts test/artifact-storage.test.ts
npm run typecheck
git diff -- dymaxion-runtime/src/capabilities/deterministic-zip.ts dymaxion-runtime/src/capabilities/artifact-storage.ts dymaxion-runtime/test/deterministic-zip.test.ts dymaxion-runtime/test/artifact-storage.test.ts
```

Expected: only ZIP/storage files changed in this todo; no dependency additions in `package.json`/lockfile.

---

## Controller Todo 3: capability+approval receipt

### Task 3.1: Implement strict schemas and canonical bundle assembly

**Objective:** Build preview archive bytes deterministically and reject malformed report/evidence/artifact input before approval or write.

**Files:**
- Create: `dymaxion-runtime/src/capabilities/export-evidence-bundle.ts`
- Create: `dymaxion-runtime/test/export-evidence-bundle.test.ts`

**Implementation outline:**

- Constants: `CAPABILITY_VERSION = '1.0.0'`; all resource limits from this plan.
- Zod schemas:
  - `JsonValueSchema` that rejects `undefined`, functions, non-finite numbers and unsupported prototypes after parsing; use `superRefine` helper for depth/nodes.
  - safe slug/name schemas.
  - strict `ExportEvidenceBundleInputSchema` with operation super-refine: `persist` requires `target_bundle_sha256`; `preview` forbids it.
  - strict `BundleManifestSchema`, `ExportBundleReportSchema`, `ExportEvidenceBundleOutputSchema`.
- Canonicalization:
  - `reportBytes = utf8(canonicalJson(input.report))` and cap <= 1 MiB.
  - `evidence = EvidenceBundleSchema.parse(input.evidence)`; `evidenceBytes = utf8(canonicalJson(evidence))` and cap <= 1 MiB.
  - `artifactBytes = utf8(input.artifact.content)` and cap <= 2 MiB.
  - Validate `sha256Text(artifact.content)` and byte count against `evidence.outputs[0]` exactly.
- The one canonical `manifest.json` shape is:

```ts
{
  schema_version: '1.0.0',
  bundle_slug,
  project_id,
  created_by: { capability: 'export_evidence_bundle', capability_version: '1.0.0' },
  zip_profile: 'store-fixed-1980-utf8-crc32-v1',
  entries: {
    manifest: { path: 'manifest.json', media_type: 'application/json; charset=utf-8' },
    report: { path: 'report.json', media_type: 'application/json; charset=utf-8', sha256, bytes },
    evidence: { path: 'evidence.json', media_type: 'application/json; charset=utf-8', sha256, bytes },
    artifact: { path: artifact.file_name, media_type: artifact.media_type, output_name, sha256, bytes }
  },
  raw_sources_included: false
}
```

The manifest has no archive hash/bytes and no hash/bytes for its own entry. Compute `manifestBytes` from this exact canonical shape, then ZIP entries in required order.

**RED tests:**

1. Valid SVG preview returns archive hash/bytes/manifest/handle and `persisted:false`, `created:false`.
2. Repeated preview with equivalent object key order returns identical archive hash and bytes.
3. Changing report, evidence, artifact content, artifact file name or output name changes hash or rejects.
4. Report/evidence/artifact caps reject before storage and before approval.
5. Unsafe slug/file/output names reject.
6. Evidence output hash/bytes/name mismatch rejects.
7. Preview with `target_bundle_sha256` rejects; persist without it rejects.
8. Archive contains exactly four STORE entries in exact order with no raw source entries.

Run:

```bash
npm test -- test/export-evidence-bundle.test.ts
```

Expected RED: FAIL because capability module does not exist.

**GREEN:** Implement schema and preview assembly only; persist may temporarily throw `persist not implemented` after hash mismatch checks until Task 3.2.

Run:

```bash
npm test -- test/export-evidence-bundle.test.ts --test-name-pattern='preview|schema|archive|mismatch|cap'
npm run typecheck
```

Expected: preview/schema tests pass; typecheck passes if Task 3.2 stubs are typed.

### Task 3.2: Bind persist to target hash, approval receipt and storage sink

**Objective:** Make persist impossible without exact preview hash and genuine consumed receipt.

**Files:**
- Modify: `dymaxion-runtime/src/capabilities/export-evidence-bundle.ts`
- Modify: `dymaxion-runtime/test/export-evidence-bundle.test.ts`
- Modify: `dymaxion-runtime/test/executor-approval.test.ts`

**Implementation requirements:**

- Add `requiresApproval(input)` to `exportEvidenceBundleCapability`: return `false` for `preview` and `true` for `persist`.
- The exact schema-parsed persist input is the canonical approval payload. It includes every archive-affecting field and `target_bundle_sha256`; request creation, consumption, registry verification, and direct sink verification must all use that same parsed object. Missing/malformed trusted identity configuration fails closed before approval or storage. A bounded human-facing approval summary may be added later, but it must not replace or alter the exact authorization payload in this phase.
- In `execute()`:
  1. Assemble archive bytes/hash for both operations.
  2. For `persist`, compare `target_bundle_sha256` to recomputed archive hash before verifying approval receipt or calling storage.
  3. Resolve the trusted identity again. Verify the registry-issued one-shot `approvalExecutionGrant`, or claim the genuine raw receipt once for an explicitly direct capability call, against `{ agentRunId, skill: 'export_evidence_bundle', payload: input, credentialIdentity }`; the helpers independently derive and check the exact target.
  4. Build response `export_evidence.approvals` as an empty array and reject injected unsigned approval claims; retain verified authority only in the approval subsystem/audit record.
  5. Get storage from `(context.io?.artifactStorage as ArtifactStorage | undefined) ?? createFileArtifactStorage()`.
  6. Publish archive bytes with project/hash; return storage result without filesystem path.
- Preview must not read or write storage and must not require `agentRunId`.
- Persist must require `agentRunId` for receipt binding; direct calls without `agentRunId` fail before storage.

**RED tests:**

1. `executeCapability('export_evidence_bundle', persistInput, contextWithoutReceipt)` rejects before storage.
2. Direct `exportEvidenceBundleCapability.execute(persistInput, contextWithoutReceipt)` rejects before storage.
3. Forged receipt object rejects before storage.
4. Receipt for different run, payload, target or credential rejects.
5. Target hash mismatch rejects before approval verification and storage.
6. Valid approved persist through `runSkill()` with `InMemoryApprovalStore`, injected approval dependencies and injected temp storage writes once and returns `persisted:true`, `created:true`.
7. Repeating valid approved persist after a new one-time approval returns `created:false` and leaves exact bytes unchanged.
8. Reusing the same approval request for a second persist fails consumption before storage.
9. Preview through `runSkill()` does not require approval despite manifest classification `copy-on-write`.
10. Planner marks preview step non-destructive and persist step destructive using the same hook.

Run:

```bash
npm test -- test/export-evidence-bundle.test.ts test/executor-approval.test.ts
```

Expected RED: FAIL for missing receipt/storage integration.

**GREEN:** Implement persist integration and adjust tests.

Run:

```bash
npm test -- test/export-evidence-bundle.test.ts test/executor-approval.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

### Task 3.3: Register capability and protect exported execution path

**Objective:** Make `export_evidence_bundle` discoverable while preserving direct-read capability behavior and denying direct writes without receipts.

**Files:**
- Modify: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify: `dymaxion-runtime/test/contracts.test.ts` or capability count tests if present
- Modify: `dymaxion-runtime/test/export-evidence-bundle.test.ts`

**Implementation requirements:**

- Register `exportEvidenceBundleCapability` after `runVectorAnalysisCapability`.
- `executeCapability()` must parse input, run the capability's pure preflight, evaluate `capabilityRequiresApproval(..., { alreadyParsed: true, parsedInput })`, and when true require a genuine receipt plus `agentRunId`, re-resolve `resolveExecutionCredentialIdentity(slug)`, atomically claim that receipt, and pass the one-shot `ConsumedApprovalExecutionGrant` to `capability.execute()`. The capability sink consumes and revalidates the grant before storage; storage rechecks the underlying genuine receipt binding at each externally visible create, and immediate private-temp cleanup remains part of the authorized publish operation.
- Read capabilities unchanged; existing direct tests for read capabilities must still pass.
- Update exact native capability count from seven to eight wherever asserted.

**RED/GREEN command:**

```bash
npm test -- test/export-evidence-bundle.test.ts test/contracts.test.ts
npm run typecheck
```

Expected GREEN after registration: `export_evidence_bundle` appears in `allCapabilities()`, preview direct execution passes, persist direct execution without receipt fails.

**Review gate 3:** Run:

```bash
npm test -- test/approval.test.ts test/executor-approval.test.ts test/deterministic-zip.test.ts test/artifact-storage.test.ts test/export-evidence-bundle.test.ts
npm run typecheck
git diff -- dymaxion-runtime/src/security/approval.ts dymaxion-runtime/src/contracts/capability.ts dymaxion-runtime/src/capabilities/registry.ts dymaxion-runtime/src/capabilities/deterministic-zip.ts dymaxion-runtime/src/capabilities/artifact-storage.ts dymaxion-runtime/src/capabilities/export-evidence-bundle.ts dymaxion-runtime/src/skills/executor.ts dymaxion-runtime/src/agent/planner.ts dymaxion-runtime/src/agent/executor.ts dymaxion-runtime/test
```

Expected: all focused tests pass; no package dependency changes.

---

## Controller Todo 4: integration/GISBench/docs

### Task 4.1: Extend GISBench from 35 to 40 official golden tasks

**Objective:** Add exactly five Phase 1G official GISBench tasks covering preview, determinism, persist/idempotency, tamper rejection and approval/storage boundary rejection.

**Files:**
- Modify: `dymaxion-runtime/src/gisbench/run.ts`
- Modify: `dymaxion-runtime/test/gisbench.test.ts`
- Modify: `dymaxion-runtime/test/gisbench-normalization.test.ts` if normalization paths are added
- Create: `gisbench/fixtures/export-evidence-bundle/preview-report.json`
- Create: `gisbench/fixtures/export-evidence-bundle/preview-evidence.json`
- Create: `gisbench/fixtures/export-evidence-bundle/useful-map.svg`
- Create: `gisbench/fixtures/export-evidence-bundle/vector-output.geojson`
- Create: `gisbench/tasks/36-export-bundle-useful-preview.json`
- Create: `gisbench/tasks/37-export-bundle-deterministic-repeat.json`
- Create: `gisbench/tasks/38-export-bundle-approved-persist-idempotent.json`
- Create: `gisbench/tasks/39-export-bundle-tamper-mismatch-reject.json`
- Create: `gisbench/tasks/40-export-bundle-storage-root-reject.json`
- Create: `gisbench/golden/export-bundle-useful-preview.json`
- Create: `gisbench/golden/export-bundle-deterministic-repeat.json`
- Create: `gisbench/golden/export-bundle-approved-persist-idempotent.json`
- Create: `gisbench/golden/export-bundle-tamper-mismatch-reject.json`
- Create: `gisbench/golden/export-bundle-storage-root-reject.json`
- Modify: `gisbench/fixtures/PROVENANCE.md`
- Modify: `gisbench/README.md`

**GISBench runner changes:**

- `TASK_COUNT = 40` and message says `5 each for Phases 0, 1A, 1B, 1C, 1D, 1E, 1F, and 1G`.
- Extend `ApprovalExpectationSchema` honestly:

```ts
z.discriminatedUnion('required', [
  z.object({ required: z.literal(false), decision: z.literal('not-requested') }).strict(),
  z.object({ required: z.literal(true), decision: z.enum(['approved', 'rejected']), consumed: z.boolean() }).strict()
])
```

- Add `ExportBundleTaskSchema` with inputs referencing fixtures and operation variants, allowed operations:
  - `boundary_preflight`
  - `canonicalize_json`
  - `build_zip_store`
  - `hash_sha256`
  - `approval_request`
  - `approval_consume`
  - `storage_publish`
  - `storage_readback`
  - `storage_reject`
- Use `InMemoryApprovalStore` and injected `approvalDependencies`.
- Use injected temp storage root under a GISBench temp directory; do not touch production `/workspace` or repo data.
- For approved persist task, run preview first inside the task to obtain `target_bundle_sha256`, then create/decide approval against exact hook payload/target, run persist, then run a second persist with a new approval to prove idempotency. Assert approval consumption from harness operations; serialize no approval claims, normalize nothing, and keep the temp root out of output.
- For tamper task, preview one input, mutate report/artifact/evidence for persist while keeping old target hash, expect error before approval/storage; operations must not include `approval_consume` or `storage_publish`.
- Task 40 models **only** one approved persist against an injected symlinked/untrusted storage root and expects one storage rejection with zero published bytes. Missing/forged approval is covered separately in focused executor/capability tests; do not combine independent failure subcases into one golden result.

**Evidence validation in GISBench:**

- For successful preview/persist, parse the normalized output and independently validate:
  - handle suffix equals `archive.sha256`.
  - manifest artifact entry hash/bytes equals exact artifact fixture bytes.
  - ZIP parsed entries are exactly four and match manifest paths/order.
  - `evidence.json` inside ZIP equals canonical upstream fixture evidence and has no persist approval fact.
  - response `export_evidence.parameters.sha256 === sha256Text(parameters.canonical_json)`.
  - preview and persist response approvals empty; approval consumption is asserted from the harness operation trace and `expected_approval`, not response metadata.
  - persisted task reports `archive.read_back_verified === true`.

**RED:** Add schemas/tasks references first, run:

```bash
npm run gisbench
npm test -- test/gisbench.test.ts
```

Expected RED: FAIL because runner/capability integration/goldens are incomplete or task count mismatches.

**GREEN:** Implement runner support, generate goldens with official harness only:

```bash
npm run gisbench -- --update-goldens
npm run gisbench
npm test -- test/gisbench.test.ts test/gisbench-normalization.test.ts
```

Expected GREEN:

- `GISBench: 40 passed, 0 failed`
- `gisbench.test.ts` asserts 40 tasks, 5 export-bundle tasks, 0 failed.

### Task 4.2: Document runtime and capability contract

**Objective:** Make operator-facing docs truthful about implemented native capability count, approval-bound storage semantics and non-goals.

**Files:**
- Create: `docs/capabilities/export-evidence-bundle.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `dymaxion-runtime/README.md` if present; if not present, do not create it only for this phase
- Modify: docs capability index only if one exists; do not invent a new index

**Docs content requirements:**

- State `export_evidence_bundle` is Phase 1G, native, `copy-on-write`, operation-aware approval.
- Explain preview vs persist and exact two-step target hash flow.
- List ZIP entries and fixed deterministic ZIP profile.
- Explain trusted storage path internally but do not expose it as a user-provided path.
- State no raw source data by default and exactly one generated SVG/GeoJSON artifact.
- State approval facts are enforced and retained by the approval subsystem/audit record but are not serialized into the response or ZIP; `export_evidence.approvals` is always empty and injected unsigned claims are rejected.
- State output schema alone cannot authenticate stored bytes; runtime read-back verification does.
- List ceilings and non-goals exactly from this plan.
- Update README/CLAUDE implemented native capability count from seven to eight and GISBench from 35 to 40.
- Do not claim encryption/signing/compression/S3/Postgres/rollback/deletion.

**Commands:**

```bash
npm run typecheck
npm test -- test/export-evidence-bundle.test.ts test/gisbench.test.ts
npm run gisbench
```

Expected: pass.

### Task 4.3: Runtime smoke and dependency audit

**Objective:** Ensure docs, package metadata, runtime startup and production dependency state are consistent.

**Files:**
- Read-only verification except docs named in Task 4.2.

Run:

```bash
git diff -- package.json dymaxion-runtime/package.json dymaxion-runtime/package-lock.json
npm run build
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test
npm audit --omit=dev --audit-level=moderate
```

Expected:

- Package/lockfile changes are limited to exact security overrides for `@hono/node-server@2.0.10` and `fast-uri@3.1.4`, added after new release-blocking advisories made the prior Hono override and transitive fast-uri version fail the required audit.
- Build and runtime smoke succeed.
- Production dependency audit reports zero moderate/high/critical vulnerabilities; record exact output.
- Exact final runtime-image production-stage audit remains a required CI/release gate rather than being inferred from the local npm audit.

**Review gate 4:** Run:

```bash
npm test -- test/export-evidence-bundle.test.ts test/gisbench.test.ts test/gisbench-normalization.test.ts
npm run gisbench
npm run typecheck
npm run build
git diff -- docs/capabilities/export-evidence-bundle.md README.md CLAUDE.md gisbench dymaxion-runtime/src/gisbench/run.ts dymaxion-runtime/test/gisbench.test.ts dymaxion-runtime/test/gisbench-normalization.test.ts
```

Expected: all pass; only Phase 1G docs/GISBench files changed in this todo.

---

## Controller Todo 5: release/review

### Task 5.1: Full local verification

**Objective:** Prove the full tree is consistent before controller commit/release.

**Commands:**

```bash
cd /Users/calmadmin/.hermes/profiles/mercator/worktrees/dymaxion-phase1g/dymaxion-runtime
npm run typecheck
npm test
npm run gisbench
npm run build
DYMAXION_CONFIG_DIR=../config SKILLS_DIR=../skills node dist/main.js smoke-test
npm audit --omit=dev --audit-level=moderate
```

Expected:

- Typecheck succeeds.
- Full test suite passes.
- GISBench prints `GISBench: 40 passed, 0 failed`.
- Build and smoke test succeed.
- Production dependency audit reports zero actionable vulnerabilities.

### Task 5.2: Security and artifact integrity checks

**Objective:** Catch path leaks, package drift, secret/NUL/oversize files and unintended source changes.

**Commands from repo root:**

```bash
cd /Users/calmadmin/.hermes/profiles/mercator/worktrees/dymaxion-phase1g
git status --short
git diff --check
git diff --name-only
python3 - <<'PY'
from pathlib import Path
bad=[]
for p in Path('.').rglob('*'):
    if '.git' in p.parts or not p.is_file():
        continue
    data=p.read_bytes()
    if b'\x00' in data:
        bad.append((str(p),'NUL'))
    if len(data) > 5*1024*1024 and not str(p).startswith('dymaxion-runtime/package-lock.json'):
        bad.append((str(p),f'{len(data)} bytes'))
print('\n'.join(f'{p}: {why}' for p,why in bad))
raise SystemExit(1 if bad else 0)
PY
python3 - <<'PY'
from pathlib import Path
needles=['BEGIN PRIVATE KEY','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','Bearer eyJ','xoxb-','-----BEGIN']
for p in Path('.').rglob('*'):
    if '.git' in p.parts or not p.is_file():
        continue
    text=p.read_text('utf-8', errors='ignore')
    for n in needles:
        if n in text:
            print(f'{p}: possible secret marker {n}')
            raise SystemExit(1)
PY
```

Expected:

- `git status --short` shows only intended Phase 1G implementation/test/docs/GISBench files.
- `git diff --check` clean.
- Python scans print nothing and exit 0.
- Package/lockfile diff is limited to the two exact security overrides documented above; no direct dependency is added.

### Task 5.3: Required review gates before controller commit

**Objective:** Ensure independent review focuses on the dangerous boundaries.

Review checklist:

1. **Spec compliance review:** Confirm all locked MVP bullets in this plan are implemented and no non-goals slipped in.
2. **Approval-boundary review:** Confirm preview cannot request/consume approval, persist cannot write without a genuine one-time receipt, and direct `executeCapability()` / direct `.execute()` write paths fail without receipt.
3. **Storage boundary review:** Confirm no caller path is accepted, all realpath containment and symlink rejections happen at the sink, and idempotency never overwrites mismatched content.
4. **Determinism review:** Independently parse ZIP bytes and confirm entry order, fixed timestamps, permissions, UTF-8 flag, CRC32, no compression and stable hash.
5. **GISBench review:** Confirm exactly five Phase 1G tasks were added, old 35 goldens were not changed unless justified, and `GISBench: 40 passed, 0 failed`.
6. **Docs honesty review:** Confirm docs do not claim schema-only persisted-byte authentication, signatures, encryption, compression, raw-source export, rollback, deletion, S3/Postgres, or live GIS.

No subagent commits. Controller commits only after all reviews approve.

### Task 5.4: Controller-owned commit and release notes

**Objective:** Leave the final tree ready for controller release flow.

Controller-only commands after approvals:

```bash
git add dymaxion-runtime/src dymaxion-runtime/test gisbench docs README.md CLAUDE.md
git commit -m "feat: add approval-bound evidence bundle export"
```

Subagents must not run these commands.

### Task 5.5: Exact-SHA independent reviews

After the controller commit, record the full immutable SHA and require fresh read-only verdicts against that exact clean tree:

1. specification compliance;
2. approval/filesystem security and deterministic ZIP integrity;
3. code quality, tests, GISBench and documentation honesty;
4. Tyr final exact-SHA release verdict.

Every reviewer must report the exact reviewed SHA and `APPROVE` or blocking findings. Any remediation creates a new controller commit and invalidates prior approvals; rerun focused/full gates and all exact-SHA reviews on the new head.

### Task 5.6: Push, PR, exact-head CI, merge and post-merge verification

Using the authenticated CLI workflow (`HOME=/Users/calmadmin`):

- secret-scan and verify clean intended diff before push;
- push the private feature branch and open a PR with scope, non-goals, tests, GISBench, provenance and exact reviewer SHA;
- require the PR head to equal the reviewed SHA and every required check to succeed, including the exact multi-architecture final runtime image build and production-stage dependency audit;
- merge normally with the repository SHA-lock option (`--match-head-commit` where available); never force-push;
- fetch `origin/main`, verify approved-head ancestry, PR state, merge SHA and remote main;
- require the post-merge workflow head SHA to equal the merge SHA and every job to succeed;
- only then update the Obsidian Phase 1G record to completed with base/remediation/approved/merge SHAs, PR and CI URLs, test counts, model/reviewer provenance, limits and next slice.

Do not mark the phase complete while exact-head or post-merge CI is pending.

## Final acceptance matrix

1. `preview` returns deterministic archive hash/bytes/manifest/handle with no approval and no storage operation.
2. Repeated preview with equivalent JSON key order returns identical archive hash.
3. `persist` requires exact preview `target_bundle_sha256` and fails on tamper before approval/storage.
4. Approved persist writes create-only/idempotently under trusted project root; second approved persist returns existing exact bytes.
5. Direct write execution via `runSkill`, `executeCapability`, or exported capability `.execute` fails without genuine consumed receipt.
6. Storage rejects symlink/non-directory components, path escape attempts, quota excess, mismatched existing content and invalid project/hash values.
7. ZIP contains exactly `manifest.json`, `report.json`, `evidence.json`, one artifact file, all STORE, fixed 1980 timestamp, deterministic permissions, UTF-8 names, valid CRC32.
8. Archive and response do not include raw source data or unsigned approval facts; `export_evidence.approvals` is always empty, while the approval subsystem/audit record retains authoritative persist facts.
9. GISBench grows 35 -> 40 with five official Phase 1G tasks and passes exactly.
10. `npm run typecheck`, `npm test`, `npm run gisbench`, `npm run build`, `git diff --check`, secret/NUL/oversize scans and independent reviews all pass.
