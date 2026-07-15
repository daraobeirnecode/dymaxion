#!/usr/bin/env bash
# Curl the Windows Worker /health endpoint and report its capabilities
# (arcpy version, ArcGIS Pro version, CLI-Anything-Arcgis-Pro availability).
set -euo pipefail

if [ -f "$(dirname "$0")/../.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$(dirname "$0")/../.env"; set +a
fi

if [ -z "${WINDOWS_WORKER_URL:-}" ]; then
  echo "WINDOWS_WORKER_URL not set — Windows Worker not configured."
  echo "ArcGIS-Pro-dependent skills (arcpy-script-runner, arcgis-pro-project-editor,"
  echo "feature-layer-publish large uploads, enterprise-gdb-connect) are disabled."
  exit 0
fi

echo "==> Checking Windows Worker at $WINDOWS_WORKER_URL"
if response="$(curl -fsS -m 10 -H "Authorization: Bearer ${WINDOWS_WORKER_SECRET:-}" "$WINDOWS_WORKER_URL/health")"; then
  echo "$response" | (command -v jq >/dev/null 2>&1 && jq . || cat)
  echo "==> Windows Worker reachable. ArcGIS Pro skills enabled."
else
  echo "==> Windows Worker UNREACHABLE. ArcGIS Pro skills will be disabled until it responds." >&2
  exit 1
fi
