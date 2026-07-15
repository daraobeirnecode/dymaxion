# Dymaxion Windows Worker uninstaller — removes the Windows Service and the
# firewall rule. Repo files remain (delete manually if desired).
$ErrorActionPreference = 'Continue'
Write-Host "==> Uninstalling Dymaxion Windows Worker..."
& "$env:USERPROFILE\.dymaxion\nssm.exe" stop DymaxionWorker
& "$env:USERPROFILE\.dymaxion\nssm.exe" remove DymaxionWorker confirm
Remove-NetFirewallRule -DisplayName "Dymaxion Windows Worker" -ErrorAction SilentlyContinue
Write-Host "==> Service removed. Repo files remain at $env:USERPROFILE\dymaxion-windows-worker (delete manually if you want)."
