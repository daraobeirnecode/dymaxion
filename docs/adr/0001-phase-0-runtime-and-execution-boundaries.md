# ADR-0001: Phase 0 runtime and execution boundaries

- Status: Accepted
- Date: 2026-07-18
- Authority: Dymaxion Best-in-Class GIS Agent Roadmap, Phase 0
- Supersedes: conflicting Sprint 1 LiteLLM, first-class Windows Worker, and “all catalog entries are production capabilities” claims

## Context

The repository contains incompatible architecture statements and a broad Sprint 1 scaffold. Some historical material describes LiteLLM as core infrastructure, treats a prompt-addressable Windows ArcPy worker as first-class, or presents all 45 skill folders as implemented and security-tested. Those claims are not an acceptable Phase 0 trust boundary.

Phase 0 needs one runtime authority, enforceable execution contracts, evidence, and a small reproducible benchmark before capability breadth.

## Decision

### Runtime

Dymaxion’s authoritative core runtime is TypeScript/Node.js with Mastra orchestration, the Vercel AI SDK for model access, and native TypeScript middleware for provider routing, boundary checks, budgets, audit and observability.

LiteLLM is not part of the core runtime. It may be reconsidered only through a later ADR with a concrete requirement, threat analysis, operational ownership and tests. Historical references do not authorize introducing it.

### Capability model

Production capabilities require versioned strict schemas, declared read/write classification, permissions/identity, allowed sources, resource limits, idempotency, dry-run/cancellation behavior, artifacts, rollback and validation metadata. Prompt-only behavior and folder presence are not evidence of an implemented capability.

The 45 existing `skills/active/` folders remain historical Sprint 1 scaffolds. Phase 0 does not expand or certify that catalog. The first implemented native capability is the read-only deterministic `inspect_dataset` GeoJSON vertical slice, invoked through the runtime dispatcher and represented in planner context.

### Execution boundaries

All untrusted capability/skill arguments are recursively preflighted before native capability content I/O or subprocess dispatch. MCP arguments are preflighted before MCP dispatch. URL checks are deny-by-default with explicit source patterns, hostname deny rules and DNS/IP checks. Filesystem checks canonicalize traversal and symlinks against explicit roots.

Subprocesses receive a narrow environment and input on stdin. Destructive operations require a persisted approval bound to the canonical payload hash, exact target, credential identity when available, expiry, atomic decision and one-time atomic consumption immediately before dispatch.

### Windows Worker

The Windows Worker is optional and disabled for execution in Phase 0. Prompt-supplied Python and ArcGIS Pro operations return a clear disabled response and cannot execute. The code may remain as historical scaffold and build coverage, but it is not a runtime capability.

A future worker requires a separate ADR and, at minimum:

- an allowlisted immutable job catalog rather than arbitrary scripts;
- authenticated job identity and capability-scoped permissions;
- input/output schemas, file provenance and resource ceilings;
- approval binding and one-time consumption at the worker boundary;
- sandboxing, adversarial tests and independent security review.

### Evidence and benchmark

Executions emit versioned evidence covering source identity/version/hash, GIS metadata, canonical parameters, deterministic execution versus model planning, output hashes/validation, approvals and rollback. GISBench Phase 0 is exactly five committed synthetic golden tasks, not a claim of broad GIS coverage.

## Consequences

- Existing LiteLLM and first-class-worker statements are historical, not operative.
- Existing skill-folder counts must not be presented as production readiness.
- Phase 0 deliberately supports only local GeoJSON inspection for the first vertical slice.
- Windows-dependent skills remain unavailable even when a worker URL is configured.
- Gateway, admin/map UI and broader skill-catalog work are outside this ADR and Phase 0.
- Any later architecture change must preserve the boundary, approval, evidence and benchmark contracts or explicitly supersede this ADR.
