#!/usr/bin/env bash
# First-time setup from a local clone: workspace dirs, .env prompt,
# docker compose up, migrations, skill registration, knowledge base load.
# (The curl-pipe installer at repo root wraps this; run this directly if
# you cloned the repo yourself.)
set -euo pipefail
cd "$(dirname "$0")/.."

exec bash install.sh --local
