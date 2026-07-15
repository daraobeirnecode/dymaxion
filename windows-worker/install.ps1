# Dymaxion Windows Worker installer.
# Run in an elevated PowerShell prompt (Right-click PowerShell -> Run as Administrator).

$ErrorActionPreference = 'Stop'

Write-Host "==> Dymaxion Windows Worker installer" -ForegroundColor Cyan

# Prerequisites
$prereqs = @(
    @{name='Node.js 20+'; check={ (node --version 2>$null) -match 'v(2[0-9]|[3-9][0-9])' }},
    @{name='Git';         check={ Get-Command git -ErrorAction SilentlyContinue }},
    @{name='ArcGIS Pro (with arcpy)'; check={ Test-Path "C:\Program Files\ArcGIS\Pro\bin\Python\envs\arcgispro-py3\python.exe" }}
)

foreach ($p in $prereqs) {
    if (-not (& $p.check)) {
        Write-Host "  MISSING: $($p.name)" -ForegroundColor Red
        if ($p.name -eq 'Node.js 20+') {
            Write-Host "    Install: https://nodejs.org/en/download/prebuilt-installer"
        } elseif ($p.name -eq 'Git') {
            Write-Host "    Install: https://git-scm.com/download/win  (or: winget install Git.Git)"
        } elseif ($p.name -eq 'ArcGIS Pro (with arcpy)') {
            Write-Host "    Install ArcGIS Pro from Esri. arcpy is bundled with Pro."
        }
        exit 1
    } else {
        Write-Host "  OK: $($p.name)" -ForegroundColor Green
    }
}

# Clone or update repo
$installDir = "$env:USERPROFILE\dymaxion-windows-worker"
if (Test-Path $installDir) {
    Write-Host "==> Updating existing install at $installDir"
    Set-Location $installDir
    git pull
} else {
    Write-Host "==> Cloning to $installDir"
    git clone https://github.com/daraobeirnecode/dymaxion "$env:USERPROFILE\dymaxion-clone"
    Move-Item "$env:USERPROFILE\dymaxion-clone\windows-worker" $installDir
    Remove-Item -Recurse -Force "$env:USERPROFILE\dymaxion-clone"
    Set-Location $installDir
}

# Install CLI-Anything-Arcgis-Pro
Write-Host "==> Installing CLI-Anything-Arcgis-Pro..."
$cliDir = "$env:USERPROFILE\.dymaxion\cli-anything-arcgis-pro"
if (-not (Test-Path $cliDir)) {
    New-Item -ItemType Directory -Path (Split-Path $cliDir -Parent) -Force | Out-Null
    git clone https://github.com/Jasper0122/CLI-Anything-Arcgis-Pro $cliDir
} else {
    Push-Location $cliDir
    git pull
    Pop-Location
}

# Shared file-shuttle directory
$sharedDir = "C:\dymaxion-shared"
New-Item -ItemType Directory -Path "$sharedDir\input" -Force | Out-Null
New-Item -ItemType Directory -Path "$sharedDir\output" -Force | Out-Null

# Install Node dependencies + build
Write-Host "==> Installing Node dependencies..."
npm install
Write-Host "==> Building..."
npm run build

# Prompt for shared secret + runtime host
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    $secret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
    (Get-Content .env) `
        -replace '^SHARED_WORKER_SECRET=.*', "SHARED_WORKER_SECRET=$secret" `
        | Set-Content .env

    Write-Host ""
    Write-Host "==> Generated shared secret for runtime-worker auth:" -ForegroundColor Yellow
    Write-Host "    $secret" -ForegroundColor Yellow
    Write-Host "    Copy this into your runtime host's .env as WINDOWS_WORKER_SECRET" -ForegroundColor Yellow
    Write-Host ""

    $runtimeHost = Read-Host "Runtime host address (leave blank if same machine as this worker)"
    if ($runtimeHost -ne '') {
        (Get-Content .env) `
            -replace '^ALLOWED_RUNTIME_HOSTS=.*', "ALLOWED_RUNTIME_HOSTS=$runtimeHost" `
            | Set-Content .env
    }
}

# Register as Windows Service (via NSSM — Non-Sucking Service Manager)
Write-Host "==> Registering as Windows Service..."
$nssmPath = "$env:USERPROFILE\.dymaxion\nssm.exe"
if (-not (Test-Path $nssmPath)) {
    Write-Host "  Downloading NSSM..."
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile "$env:TEMP\nssm.zip"
    Expand-Archive -Path "$env:TEMP\nssm.zip" -DestinationPath "$env:TEMP\nssm" -Force
    Copy-Item "$env:TEMP\nssm\nssm-2.24\win64\nssm.exe" $nssmPath
    Remove-Item "$env:TEMP\nssm.zip"
    Remove-Item -Recurse "$env:TEMP\nssm"
}

$nodePath = (Get-Command node).Source
$mainJs = "$installDir\dist\main.js"

# Remove existing service if present
& $nssmPath status DymaxionWorker 2>$null
if ($LASTEXITCODE -eq 0) {
    & $nssmPath stop DymaxionWorker
    & $nssmPath remove DymaxionWorker confirm
}

# Install fresh
& $nssmPath install DymaxionWorker $nodePath $mainJs
& $nssmPath set DymaxionWorker AppDirectory $installDir
& $nssmPath set DymaxionWorker DisplayName "Dymaxion GIS Agent - Windows Worker"
& $nssmPath set DymaxionWorker Description "Handles ArcGIS Pro CLI + arcpy invocations for the Dymaxion agent runtime"
& $nssmPath set DymaxionWorker Start SERVICE_AUTO_START
& $nssmPath set DymaxionWorker AppStdout "$installDir\logs\stdout.log"
& $nssmPath set DymaxionWorker AppStderr "$installDir\logs\stderr.log"

New-Item -ItemType Directory -Path "$installDir\logs" -Force | Out-Null

# Firewall rule: allow port 4444 on Private + Domain profiles only
New-NetFirewallRule -DisplayName "Dymaxion Windows Worker" `
    -Direction Inbound -Protocol TCP -LocalPort 4444 `
    -Profile Private,Domain -Action Allow `
    -ErrorAction SilentlyContinue

# Start the service
& $nssmPath start DymaxionWorker

Write-Host ""
Write-Host "=================================================="
Write-Host "  Dymaxion Windows Worker installed and running." -ForegroundColor Green
Write-Host "=================================================="
Write-Host ""
Write-Host "  Service name:      DymaxionWorker"
Write-Host "  Listening on:      http://0.0.0.0:4444"
Write-Host "  Shared dir:        $sharedDir"
Write-Host "  Logs:              $installDir\logs\"
Write-Host "  Install dir:       $installDir"
Write-Host ""
Write-Host "  Test:              curl http://localhost:4444/health -H 'Authorization: Bearer <secret>'"
Write-Host "  Stop:              Stop-Service DymaxionWorker"
Write-Host "  Start:             Start-Service DymaxionWorker"
Write-Host "  Uninstall:         .\uninstall.ps1"
Write-Host ""
Write-Host "  On your runtime host, set these .env vars:"
Write-Host "    WINDOWS_WORKER_URL=http://<this-machine-tailscale-ip-or-host.docker.internal>:4444"
Write-Host "    WINDOWS_WORKER_SECRET=<the shared secret shown above>"
Write-Host ""
