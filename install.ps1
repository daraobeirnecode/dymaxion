# Dymaxion installer — Windows (Topology A: single Windows machine).
# Run in an elevated PowerShell (Right-click PowerShell -> Run as Administrator):
#   irm https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/install.ps1 | iex
#
# Sets up WSL2 Ubuntu + Docker Desktop for the main runtime, clones the repo
# into WSL, runs install.sh there, then registers the native Windows Worker
# service (windows-worker/install.ps1) so ArcGIS Pro CLI + arcpy skills work
# from day one. Auto-populates WINDOWS_WORKER_URL=http://host.docker.internal:4444.

$ErrorActionPreference = 'Stop'

Write-Host "==> Dymaxion installer (Windows)" -ForegroundColor Cyan

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Please run this installer from an elevated PowerShell (Run as Administrator)." -ForegroundColor Red
    exit 1
}

# --- 1. WSL2 -----------------------------------------------------------
$wslInstalled = $false
try { wsl --status *> $null; $wslInstalled = ($LASTEXITCODE -eq 0) } catch {}
if (-not $wslInstalled) {
    Write-Host "==> Installing WSL2 + Ubuntu (a reboot may be required, then re-run this installer)..."
    wsl --install -d Ubuntu
    Write-Host "==> WSL2 install initiated. If Windows asks you to reboot, do so and re-run this installer." -ForegroundColor Yellow
    exit 0
}
Write-Host "  OK: WSL2 present" -ForegroundColor Green

# --- 2. Docker Desktop -------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "==> Docker Desktop not found."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        $ans = Read-Host "Install Docker Desktop via winget? [Y/n]"
        if ($ans -notmatch '^[Nn]') {
            winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
            Write-Host "==> Docker Desktop installed. Start it once, enable the WSL2 backend, then re-run this installer." -ForegroundColor Yellow
            exit 0
        }
    }
    Write-Host "    Install manually: https://docs.docker.com/desktop/setup/install/windows-install/" -ForegroundColor Red
    exit 1
}
Write-Host "  OK: Docker Desktop present" -ForegroundColor Green

# --- 3. Main runtime inside WSL2 ---------------------------------------
Write-Host "==> Installing the main Dymaxion stack inside WSL2 Ubuntu..."
wsl -d Ubuntu -- bash -lc "command -v git >/dev/null || (sudo apt-get update && sudo apt-get install -y git curl jq)"
wsl -d Ubuntu -- bash -lc "[ -d ~/dymaxion ] || git clone https://github.com/daraobeirnecode/dymaxion ~/dymaxion"
Write-Host ""
Write-Host "==> Handing off to install.sh inside WSL (interactive prompts follow)..." -ForegroundColor Cyan
wsl -d Ubuntu -- bash -lc "cd ~/dymaxion && bash install.sh --local"

# --- 4. Native Windows Worker (ArcGIS Pro CLI + arcpy) ------------------
Write-Host ""
$ans = Read-Host "Register the Windows Worker service for ArcGIS Pro CLI + arcpy on this machine? [Y/n]"
if ($ans -notmatch '^[Nn]') {
    $workerInstaller = Join-Path $PSScriptRoot "windows-worker\install.ps1"
    if (Test-Path $workerInstaller) {
        & $workerInstaller
    } else {
        # curl-pipe mode: pull the worker installer from the repo
        irm https://raw.githubusercontent.com/daraobeirnecode/dymaxion/main/windows-worker/install.ps1 | iex
    }
    Write-Host ""
    Write-Host "==> Wiring runtime -> worker (Topology A: host.docker.internal)..." -ForegroundColor Cyan
    Write-Host "    Set in ~/dymaxion/.env inside WSL:"
    Write-Host "      WINDOWS_WORKER_URL=http://host.docker.internal:4444"
    Write-Host "      WINDOWS_WORKER_SECRET=<the shared secret printed above>"
    Write-Host "    Then: wsl -d Ubuntu -- bash -lc 'cd ~/dymaxion && docker compose restart dymaxion-runtime'"
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Dymaxion installed." -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Admin dashboard:  http://127.0.0.1:3001 (or your Tailscale IP)"
Write-Host "  LangFuse traces:  http://localhost:3000"
Write-Host "  Worker health:    curl http://localhost:4444/health"
Write-Host ""
