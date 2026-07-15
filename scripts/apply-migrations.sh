#!/usr/bin/env bash
# Apply all SQL migrations in order against the dymaxion-postgres container.
# Idempotent — every migration uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${DYMAXION_PG_CONTAINER:-dymaxion-postgres}"

for f in migrations/*.sql; do
  echo "==> Applying $f"
  docker exec -i "$CONTAINER" psql -U dymaxion -d dymaxion -v ON_ERROR_STOP=1 < "$f"
done

echo "==> Migrations applied."
