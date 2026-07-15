#!/usr/bin/env bash
# Scan skills/active/, validate each skill folder, and register the catalog
# into dymaxion.skill_registry. Runs inside the runtime container (which has
# the registry code); safe to re-run — registration is upsert-based.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${DYMAXION_RUNTIME_CONTAINER:-dymaxion-runtime}"

if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  docker exec "$CONTAINER" node dist/main.js register-skills
else
  echo "Runtime container not running — registering via local node build..."
  (cd dymaxion-runtime && npm run build --silent && \
   DYMAXION_CONFIG_DIR="$(pwd)/../config" SKILLS_DIR="$(pwd)/../skills" node dist/main.js register-skills)
fi

echo "==> Skill catalog registered."
