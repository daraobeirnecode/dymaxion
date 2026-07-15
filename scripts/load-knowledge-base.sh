#!/usr/bin/env bash
# Chunk + embed every knowledge-base doc into dymaxion.messages under the
# 'system-seed' gateway. Requires VOYAGE_API_KEY. Pass --refresh to re-embed
# only files whose mtime is newer than their last-embedded timestamp.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${DYMAXION_RUNTIME_CONTAINER:-dymaxion-runtime}"
FLAGS="${1:-}"

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker exec "$CONTAINER" node dist/main.js load-knowledge-base $FLAGS
else
  echo "Runtime container not running — loading via local node build..."
  (cd dymaxion-runtime && npm run build --silent && \
   DYMAXION_CONFIG_DIR="$(pwd)/../config" KNOWLEDGE_BASE_DIR="$(pwd)/../knowledge-base" node dist/main.js load-knowledge-base $FLAGS)
fi

echo "==> Knowledge base loaded."
