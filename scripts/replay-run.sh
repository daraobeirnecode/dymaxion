#!/usr/bin/env bash
# Re-execute a past agent run by ID: reloads the stored plan from
# dymaxion.agent_runs and runs the same skill sequence with the same inputs.
# Usage: scripts/replay-run.sh <agent-run-uuid>
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "Usage: $0 <agent-run-uuid>" >&2
  exit 1
fi

CONTAINER="${DYMAXION_RUNTIME_CONTAINER:-dymaxion-runtime}"
docker exec "$CONTAINER" node dist/main.js replay-run "$1"
