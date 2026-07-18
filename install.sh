#!/usr/bin/env bash
set -euo pipefail

# Dymaxion installer — cross-platform (macOS, Linux).
# Detects OS, checks prereqs (installs missing ones on macOS via Homebrew
# with confirmation), clones the repo when run via curl-pipe, prompts for
# essential env vars, generates strong secrets, brings the stack up, applies
# migrations, registers skills, loads the knowledge base, and verifies.
#
#   curl -fsSL https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/install.sh | bash
#   OR from a clone: ./install.sh --local
#
# Windows users: run install.ps1 in an elevated PowerShell instead.

INSTALL_DIR="${DYMAXION_INSTALL_DIR:-$HOME/dymaxion}"
REPO_URL="https://github.com/daraobeirnecode/dymaxion"
LOCAL_MODE=0
[ "${1:-}" = "--local" ] && LOCAL_MODE=1

echo "==> Dymaxion installer"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Darwin*) PLATFORM=macos ;;
  Linux*)  PLATFORM=linux ;;
  *) echo "Unsupported OS: $OS. Dymaxion supports macOS and Linux (Windows: use install.ps1)." >&2; exit 1 ;;
esac
echo "==> Platform: $PLATFORM"

# Check prereqs
need_install=()
command -v docker >/dev/null 2>&1 || need_install+=("docker")
command -v git    >/dev/null 2>&1 || need_install+=("git")
command -v node   >/dev/null 2>&1 || need_install+=("node")
command -v curl   >/dev/null 2>&1 || need_install+=("curl")

if [ ${#need_install[@]} -gt 0 ]; then
  echo "==> Missing: ${need_install[*]}"
  if [ "$PLATFORM" = macos ]; then
    if command -v brew >/dev/null 2>&1; then
      read -r -p "Install via Homebrew? [Y/n] " ans
      if [[ ! $ans =~ ^[Nn] ]]; then
        for pkg in "${need_install[@]}"; do
          case "$pkg" in
            docker) brew install --cask docker ;;
            *)      brew install "$pkg" ;;
          esac
        done
      else
        echo "Cannot continue without prerequisites." >&2; exit 1
      fi
    else
      echo "Homebrew not found. Install Homebrew first: https://brew.sh" >&2
      exit 1
    fi
  else
    echo "Install manually:" >&2
    echo "  Docker: https://docs.docker.com/engine/install/" >&2
    echo "  Node 20+: https://nodejs.org" >&2
    echo "  git, curl: use your distro package manager" >&2
    exit 1
  fi
fi

# Node version gate (20+)
node_major="$(node --version | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -lt 20 ]; then
  echo "Node 20+ required (found $(node --version))." >&2
  exit 1
fi

# Clone repo if run via curl-pipe
if [ "$LOCAL_MODE" -eq 1 ]; then
  INSTALL_DIR="$(pwd)"
else
  if [ ! -d "$INSTALL_DIR" ]; then
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
fi
echo "==> Install location: $INSTALL_DIR"

# Prompt for essential env vars
if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Prompting for essential env vars (everything else gets strong defaults)..."
  echo ""
  read -r -p "Anthropic API key (starts with sk-ant-): " anthropic_key
  read -r -p "Telegram bot token (from @BotFather): "    telegram_token
  read -r -p "Your Telegram chat ID: "                   telegram_chat_id
  read -r -p "Voyage API key (for embeddings): "         voyage_key
  read -r -p "Tailscale login allowed to approve (email/login): " admin_identity

  # Generate strong random secrets
  postgres_password="$(openssl rand -hex 24)"
  langfuse_secret="$(openssl rand -hex 32)"
  langfuse_salt="$(openssl rand -hex 16)"
  langfuse_enc_key="$(openssl rand -hex 32)"
  oauth_enc_key="$(openssl rand -hex 32)"
  runtime_internal_token="$(openssl rand -hex 32)"

  sed -i.bak \
    -e "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$anthropic_key|" \
    -e "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$telegram_token|" \
    -e "s|^TELEGRAM_ADMIN_CHAT_ID=.*|TELEGRAM_ADMIN_CHAT_ID=$telegram_chat_id|" \
    -e "s|^VOYAGE_API_KEY=.*|VOYAGE_API_KEY=$voyage_key|" \
    -e "s|^DYMAXION_ADMIN_IDENTITIES=.*|DYMAXION_ADMIN_IDENTITIES=$admin_identity|" \
    -e "s|^RUNTIME_INTERNAL_TOKEN=.*|RUNTIME_INTERNAL_TOKEN=$runtime_internal_token|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$postgres_password|" \
    -e "s|^LANGFUSE_NEXTAUTH_SECRET=.*|LANGFUSE_NEXTAUTH_SECRET=$langfuse_secret|" \
    -e "s|^LANGFUSE_SALT=.*|LANGFUSE_SALT=$langfuse_salt|" \
    -e "s|^LANGFUSE_ENCRYPTION_KEY=.*|LANGFUSE_ENCRYPTION_KEY=$langfuse_enc_key|" \
    -e "s|^OAUTH_TOKEN_ENCRYPTION_KEY=.*|OAUTH_TOKEN_ENCRYPTION_KEY=$oauth_enc_key|" \
    .env
  rm -f .env.bak

  # ADMIN_BIND_HOST deliberately stays on loopback. Directly binding the
  # dashboard to a tailnet IP would let clients spoof identity headers.

  # Optional remote Windows Worker (Topology B/C)
  echo ""
  read -r -p "Do you have a Windows machine with ArcGIS Pro that Dymaxion should reach? [y/N] " has_worker
  if [[ $has_worker =~ ^[Yy] ]]; then
    echo ""
    echo "  On that Windows machine, in an elevated PowerShell, run:"
    echo "    irm https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/windows-worker/install.ps1 | iex"
    echo "  It prints a shared secret. Then set in this machine's .env:"
    echo "    WINDOWS_WORKER_URL=http://<windows-tailscale-ip>:4444"
    echo "    WINDOWS_WORKER_SECRET=<the shared secret>"
    echo ""
    read -r -p "Windows Worker URL (blank to configure later): " worker_url
    if [ -n "$worker_url" ]; then
      read -r -p "Windows Worker shared secret: " worker_secret
      sed -i.bak \
        -e "s|^WINDOWS_WORKER_URL=.*|WINDOWS_WORKER_URL=$worker_url|" \
        -e "s|^WINDOWS_WORKER_SECRET=.*|WINDOWS_WORKER_SECRET=$worker_secret|" \
        .env
      rm -f .env.bak
    fi
  fi
fi

# Start stack
echo "==> Starting Docker Compose stack..."
docker compose up -d --build

echo "==> Approval dashboard authentication requires Tailscale Serve."
echo "    Configure it with: tailscale serve --bg localhost:3001"

# Wait for healthchecks
echo "==> Waiting for services to become healthy (up to 3 minutes)..."
timeout=180
while [ $timeout -gt 0 ]; do
  unhealthy="$(docker compose ps --format json 2>/dev/null | jq -rs '[.[] | select(.Health != null and .Health != "" and .Health != "healthy")] | length' 2>/dev/null || echo 1)"
  if [ "$unhealthy" = "0" ]; then break; fi
  sleep 5
  timeout=$((timeout - 5))
done
if [ $timeout -le 0 ]; then
  echo "==> WARNING: some services haven't reached healthy state. Check: docker compose ps"
fi

# Migrations + skills + knowledge base
echo "==> Applying migrations..."
bash scripts/apply-migrations.sh

echo "==> Registering initial skill catalog..."
bash scripts/register-initial-skills.sh

echo "==> Loading knowledge base..."
bash scripts/load-knowledge-base.sh

echo "==> Verifying MCP servers..."
bash scripts/verify-mcp-servers.sh || echo "==> WARNING: one or more MCP servers failed handshake (see above)."

echo "==> Checking Windows Worker..."
bash scripts/verify-windows-worker.sh || true

admin_host="$(grep '^ADMIN_BIND_HOST=' .env | cut -d= -f2)"
echo ""
echo "=================================================="
echo "  Dymaxion installed and running."
echo "=================================================="
echo ""
echo "  Admin dashboard:  http://${admin_host:-127.0.0.1}:3001"
echo "  LangFuse traces:  http://localhost:3000"
echo "  Telegram bot:     find your bot in Telegram and message 'hi'"
echo "  CLI REPL:         docker exec -it dymaxion-runtime dymaxion"
echo ""
echo "  To connect additional LLM providers (OpenAI, Google, Azure, Cohere):"
echo "    Open the admin dashboard -> Providers -> Connect"
echo ""
echo "  To view logs:     docker compose logs -f dymaxion-runtime"
echo "  To restart:       docker compose restart"
echo "  To upgrade:       cd $INSTALL_DIR && git pull && docker compose up -d --build"
echo ""
