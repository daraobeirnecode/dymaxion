# Dymaxion Windows Worker — Phase 0 scaffold

The Windows Worker is optional and execution-disabled in Phase 0. It may be built to verify the historical transport scaffold, but it does not execute ArcPy scripts or ArcGIS Pro CLI operations. See [`ADR-0001`](../docs/adr/0001-phase-0-runtime-and-execution-boundaries.md).

## Phase 0 API

All endpoints require the configured bearer credential.

| Endpoint | Phase 0 behavior |
| --- | --- |
| `GET /health` | Historical environment/readiness report |
| `POST /arcpy/run` | HTTP 410; prompt-supplied Python cannot execute |
| `POST /pro-cli/run` | HTTP 410; prompt-supplied Pro operations cannot execute |
| `POST /files/upload?run_id=&name=` | Authenticated file-transport scaffold |
| `GET /files/download?run_id=&name=` | Authenticated file-transport scaffold |

The arbitrary-script and unrestricted Pro CLI runners have been removed. Runtime availability remains false even if `WINDOWS_WORKER_URL` is configured.

## Historical installer

`install.ps1` is retained for the historical Sprint 1 scaffold. Running it does not change the Phase 0 disabled-execution policy. Do not treat a successful health response as authorization to run Windows jobs.

A future execution worker requires an allowlisted immutable job catalog, capability-scoped identity, strict schemas and resource limits, bound approvals, evidence, sandboxing, adversarial tests and independent security review before these routes can be replaced.

## Build verification

```powershell
npm ci
npm run typecheck
npm run build
```

## Uninstall

```powershell
.\uninstall.ps1
```
