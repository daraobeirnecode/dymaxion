#!/usr/bin/env bash
# Start each MCP server from config/mcp-servers.yaml, verify the MCP
# handshake (initialize → tools/list), then shut it down. Reports one line
# per server; exits non-zero if any REQUIRED server fails.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${DYMAXION_RUNTIME_CONTAINER:-dymaxion-runtime}"

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker exec "$CONTAINER" node dist/main.js verify-mcp
else
  echo "Runtime container not running — verifying via local node build..."
  (cd dymaxion-runtime && npm run build --silent && node dist/main.js verify-mcp)
fi
