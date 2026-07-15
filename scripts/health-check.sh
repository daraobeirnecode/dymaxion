#!/usr/bin/env bash
# Check every container healthcheck + external API reachability + the
# Windows Worker. Exit 0 only if all REQUIRED components are healthy.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

echo "==> Containers"
for c in dymaxion-postgres dymaxion-langfuse dymaxion-whisper dymaxion-runtime dymaxion-admin dymaxion-skill-sandbox; do
  state="$(docker inspect --format '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$c" 2>/dev/null || echo 'missing')"
  echo "  $c: $state"
  case "$state" in
    running|running/healthy) ;;
    *) fail=1 ;;
  esac
done

echo "==> External APIs"
if [ -f .env ]; then set -a; source .env; set +a; fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" || echo 000)"
  echo "  anthropic: HTTP $code"
  [ "$code" = "200" ] || fail=1
else
  echo "  anthropic: no API key set"; fail=1
fi

if [ -n "${VOYAGE_API_KEY:-}" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://api.voyageai.com/v1/embeddings -H "Authorization: Bearer $VOYAGE_API_KEY" -H 'Content-Type: application/json' -d '{"model":"voyage-3-large","input":["ping"]}' || echo 000)"
  echo "  voyage: HTTP $code"
  [ "$code" = "200" ] || fail=1
else
  echo "  voyage: no API key set (embeddings disabled)"
fi

if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" || echo 000)"
  echo "  telegram: HTTP $code"
  [ "$code" = "200" ] || fail=1
else
  echo "  telegram: no bot token set"; fail=1
fi

echo "==> Windows Worker (optional)"
bash scripts/verify-windows-worker.sh || true

if [ "$fail" -eq 0 ]; then
  echo "==> ALL REQUIRED COMPONENTS HEALTHY"
else
  echo "==> HEALTH CHECK FAILED — see above" >&2
fi
exit "$fail"
