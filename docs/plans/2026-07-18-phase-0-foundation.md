# Dymaxion Phase 0 Foundation Implementation Plan

> **For Mercator:** Implement directly in the isolated `feat/phase-0-foundation` worktree. Do not delegate, touch Tyr's checkout, or include `fix/telegram-latency-feedback`.

**Goal:** Deliver the roadmap's rollback-safe Phase 0 trust foundation plus one real, deterministic `inspect_dataset` capability.

**Architecture:** Keep the TypeScript/Mastra/Vercel AI SDK runtime. Add strict versioned Zod contracts and a native capability path alongside the historical skill scaffolds. Put recursive boundary preflight ahead of dispatch/I/O, and make approval decisions and consumption atomic through a persistence interface backed by Postgres in production and an explicitly atomic in-memory store in tests.

**Tech Stack:** TypeScript 5.8, Node 20+, Zod, Drizzle/Postgres, Node test runner through tsx, local GeoJSON fixtures.

---

### Task 1: Record the authoritative architecture decision

**Files:**
- Create: `docs/adr/0001-phase-0-runtime-and-execution-boundaries.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

1. Add an ADR selecting the TypeScript runtime, Mastra/Vercel AI SDK/native middleware, no core LiteLLM, and a disabled-by-default optional Windows Worker pending redesign/security testing.
2. Link the ADR from README and CLAUDE.md.
3. Mark the 45 legacy skill folders and prior Windows Worker claims as historical scaffolding without broad documentation churn.

### Task 2: Add strict capability and evidence contracts

**Files:**
- Create: `dymaxion-runtime/src/contracts/capability.ts`
- Create: `dymaxion-runtime/src/contracts/evidence.ts`
- Create: `dymaxion-runtime/src/contracts/canonical.ts`
- Test: `dymaxion-runtime/test/contracts.test.ts`
- Modify: `dymaxion-runtime/package.json`

1. Write failing tests proving unknown fields are rejected and all roadmap-required metadata is represented.
2. Add Zod and strict, versioned input/output/manifest/evidence schemas.
3. Add deterministic canonical JSON and SHA-256 helpers.
4. Run the focused contract tests.

### Task 3: Enforce URL and path boundaries before dispatch or I/O

**Files:**
- Modify: `dymaxion-runtime/src/security/boundary.ts`
- Modify: `dymaxion-runtime/src/skills/executor.ts`
- Modify: `dymaxion-runtime/src/mcp/client.ts`
- Modify: `dymaxion-runtime/src/worker/client.ts`
- Modify: `dymaxion-runtime/src/config/loader.ts`
- Test: `dymaxion-runtime/test/boundary.test.ts`

1. Write adversarial tests for nested URLs, non-allowlisted hosts, path traversal, symlink escape, and pre-I/O blocking.
2. Canonicalize paths, resolve symlinks/nearest ancestors, recursively inspect nested objects/arrays, deny unknown URI schemes, and require URL/path allowlist matches.
3. Call the preflight from the real skill/capability dispatcher, MCP tool dispatch, and optional worker request path before any dispatch or data I/O.
4. Keep the Windows execution path unavailable in Phase 0.

### Task 4: Bind approvals and make them one-time and atomic

**Files:**
- Create: `migrations/004_phase0_approval_binding.sql`
- Modify: `dymaxion-runtime/src/db/schema.ts`
- Rewrite: `dymaxion-runtime/src/security/approval.ts`
- Modify: `dymaxion-runtime/src/gateways/common.ts`
- Modify: `dymaxion-runtime/src/agent/executor.ts`
- Modify: gateway approval handlers as needed
- Test: `dymaxion-runtime/test/approval.test.ts`

1. Write tests for replay, payload mutation, target swap, credential mismatch, expiry, duplicate decisions, duplicate consumption, and concurrent decisions.
2. Persist canonical payload hash, exact target, credential identity when available, expiry, decision, and consumption timestamp.
3. Use conditional updates for atomic decision/expiry/consumption.
4. Remove boolean pre-approval bypasses and consume the exact binding before dispatch, including replayed plans.

### Task 5: Implement `inspect_dataset` as a real native capability

**Files:**
- Create: `dymaxion-runtime/src/capabilities/inspect-dataset.ts`
- Create: `dymaxion-runtime/src/capabilities/registry.ts`
- Modify: runtime registry/planner/executor/CLI integration files
- Test: `dymaxion-runtime/test/inspect-dataset.integration.test.ts`

1. Write failing end-to-end tests through the runtime dispatcher.
2. Add a strict read-only GeoJSON input/output contract and resource limit.
3. Preflight the local source before stat/open/read.
4. Produce a dataset passport with URI, retrieval timestamp, file hash, format, CRS/axis order/units, extent, schema, feature count, geometry types, temporal fields, warnings, and a versioned evidence bundle.
5. Reject malformed, unsupported, oversized, and boundary-blocked inputs honestly.

### Task 6: Scaffold the five-task GISBench MVP

**Files:**
- Create: `gisbench/README.md`
- Create: `gisbench/tasks/*.json`
- Create: `gisbench/fixtures/*`
- Create: `gisbench/golden/*.json`
- Create: `dymaxion-runtime/src/gisbench/run.ts`
- Modify: `dymaxion-runtime/package.json`
- Test: `dymaxion-runtime/test/gisbench.test.ts`

1. Commit only small synthetic fixtures with explicit provenance.
2. Cover valid dataset inspection, mixed-geometry QA, malformed input, resource-limit rejection, and boundary traversal.
3. Record tolerances, allowed operations, and expected approval behavior per task.
4. Compare deterministic normalized outputs/errors to committed goldens.

### Task 7: Verify, review, and publish the branch

1. Run focused tests, all runtime tests, typecheck, runtime build, smoke test, GISBench, admin build, worker build, and Compose validation.
2. Inspect status, complete diff, generated-file policy, and untracked files.
3. Stage only intended files; run staged diff check/stat/numstat and reject unexpected binary text files or controls.
4. Run a staged secret scan.
5. Configure Dara's repo-local GitHub noreply identity, create one conventional commit, push with `HOME=/Users/calmadmin`, and open a PR against `main`.
6. Verify the PR is open, unmerged, base `main`, head `feat/phase-0-foundation`, and report CI status available before completion.
