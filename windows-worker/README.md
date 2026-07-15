# Dymaxion Windows Worker

Small Node.js HTTP service that exposes ArcGIS Pro CLI + arcpy execution to
the Dymaxion runtime over a REST API. ArcGIS Pro, arcpy, and several Esri
extensions are Windows-only — this worker closes that gap.

## Install (elevated PowerShell)

```powershell
irm https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/windows-worker/install.ps1 | iex
# or from a clone:
.\install.ps1
```

The installer checks prerequisites (Node 20+, Git, ArcGIS Pro), clones
CLI-Anything-Arcgis-Pro, builds, generates a shared secret, registers the
service via NSSM (auto-start on boot), and adds a firewall rule scoped to
Private + Domain network profiles.

Then on the runtime host, set in `.env`:

```
WINDOWS_WORKER_URL=http://<tailscale-ip-or-host.docker.internal>:4444
WINDOWS_WORKER_SECRET=<the secret install.ps1 printed>
```

## API (all require `Authorization: Bearer <SHARED_WORKER_SECRET>`)

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | readiness + capability report (arcpy version, Pro version, disk, load) |
| `POST /arcpy/run` | execute an arcpy script in `arcgispro-py3` |
| `POST /pro-cli/run` | invoke a CLI-Anything-Arcgis-Pro operation |
| `POST /files/upload?run_id=&name=` | shuttle a file to `C:\dymaxion-shared\input\<run-id>\` |
| `GET /files/download?run_id=&name=` | shuttle a file from `C:\dymaxion-shared\output\<run-id>\` |

The runtime polls `/health` every 30s; the ArcGIS-Pro-dependent skills
(`arcpy-script-runner`, `arcgis-pro-project-editor`, `feature-layer-publish`,
`enterprise-gdb-connect`) toggle availability with worker status.

## Security

- Shared-secret Bearer auth (constant-time compare); optional
  `ALLOWED_RUNTIME_HOSTS` allowlist
- Binds 0.0.0.0:4444; firewall restricts to Private + Domain profiles
- Execution scope confined to `C:\dymaxion-shared` — scripts referencing
  paths outside the share are rejected pre-execution
- Employer boundary denied-path patterns are passed in each request and
  enforced before execution
- All actions logged to `logs\worker-YYYY-MM-DD.log`

## Uninstall

```powershell
.\uninstall.ps1
```
