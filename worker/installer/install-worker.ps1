[CmdletBinding()]
param(
    [string]$ServerUrl = $env:FRAMECUT_SERVER_URL,
    [string]$JoinCode = $env:FRAMECUT_JOIN_CODE,
    [string]$WorkerName = $env:FRAMECUT_WORKER_NAME
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Require-Admin {
    $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        if ($ServerUrl) { $env:FRAMECUT_SERVER_URL = $ServerUrl }
        if ($JoinCode) { $env:FRAMECUT_JOIN_CODE = $JoinCode }
        if ($WorkerName) { $env:FRAMECUT_WORKER_NAME = $WorkerName }
        Start-Process PowerShell.exe -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") -Wait
        exit $LASTEXITCODE
    }
}
function Protect-Token([string]$Token) {
    Add-Type -AssemblyName System.Security
    $raw = [Text.Encoding]::UTF8.GetBytes($Token)
    $cipher = [Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($cipher)
}
function Gpu-Info {
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    $line = $null
    if ($smi) { try { $line = (& $smi.Source '--query-gpu=name,driver_version,memory.total' '--format=csv,noheader' 2>$null | Select-Object -First 1).Trim() } catch {} }
    [ordered]@{ nvidiaSmi = [bool]$smi; description = $line }
}

Require-Admin
if (-not $ServerUrl) { $ServerUrl = Read-Host 'FrameCut-Adresse (z. B. http://10.0.60.131:4317)' }
if (-not $WorkerName) { $WorkerName = Read-Host 'Worker-Name (z. B. Gaming-PC)' }
$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl muss mit http:// oder https:// beginnen.' }

Step 'Installer-Manifest vom FrameCut-Server laden'
$manifestResponse = Invoke-WebRequest -Uri "$ServerUrl/api/worker/installer/manifest" -UseBasicParsing -TimeoutSec 20
$manifest = $manifestResponse.Content | ConvertFrom-Json
foreach ($required in @('version','downloadUrl','sha256','entrypoint')) {
    if (-not $manifest.$required) { throw "Manifest-Feld fehlt: $required" }
}

Step 'GPU und freien Speicher prüfen'
$gpu = Gpu-Info
if (-not $gpu.nvidiaSmi) { Write-Warning 'nvidia-smi fehlt. NVIDIA-Treiber vor dem Rendern installieren.' }
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
$freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
if ($freeGb -lt 75) { Write-Warning "Nur $freeGb GB frei; MiniMax H3 benötigt ungefähr 75 GB." }

Step 'Tailscale prüfen'
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if ($tailscale) {
    try { $ts = (& $tailscale.Source status --json 2>$null | ConvertFrom-Json); if ($ts.BackendState -ne 'Running') { Write-Warning 'Tailscale ist nicht verbunden.' } } catch { Write-Warning 'Tailscale-Status nicht lesbar.' }
} else { Write-Warning 'Tailscale nicht installiert; der Server muss lokal erreichbar sein.' }

if (-not $JoinCode) { $JoinCode = Read-Host 'Einmaligen FrameCut-Registrierungscode eingeben' }
if ([string]::IsNullOrWhiteSpace($JoinCode)) { throw 'Registrierungscode fehlt.' }
$gpuJson = $gpu | ConvertTo-Json -Depth 3
$body = [ordered]@{ joinCode=$JoinCode; name=$WorkerName; machine=$env:COMPUTERNAME; os='windows'; architecture=$env:PROCESSOR_ARCHITECTURE; gpu=$gpu; capabilities=@('comfyui','minimax-h3'); installerVersion='phase1' } | ConvertTo-Json -Depth 6

Step 'Worker registrieren'
$registration = Invoke-RestMethod -Uri "$ServerUrl/api/worker/register" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
if (-not $registration.workerId -or -not $registration.workerToken) { throw 'Registrierung lieferte keine Worker-Zugangsdaten.' }

$root = Join-Path $env:ProgramData 'FrameCut\Worker'
$versionRoot = Join-Path $root "versions\$($manifest.version)"
New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
$zip = Join-Path $env:TEMP "framecut-worker-$($manifest.version).zip"
Step "Worker $($manifest.version) herunterladen und prüfen"
Invoke-WebRequest -Uri $manifest.downloadUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $manifest.sha256.ToString().ToLowerInvariant()) { throw "SHA-256-Prüfung fehlgeschlagen: $actual" }
Expand-Archive -LiteralPath $zip -DestinationPath $versionRoot -Force

$config = [ordered]@{ serverUrl=$ServerUrl; workerId=$registration.workerId; workerName=$WorkerName; workerTokenProtected=(Protect-Token $registration.workerToken); version=$manifest.version; installedAt=(Get-Date).ToUniversalTime().ToString('o') }
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'worker.json') -Encoding UTF8
$entrypoint = Join-Path $versionRoot $manifest.entrypoint
if (Test-Path -LiteralPath $entrypoint) {
    Step 'Worker-Autostart einrichten'
    $action = New-ScheduledTaskAction -Execute $entrypoint -WorkingDirectory (Split-Path $entrypoint)
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName 'FrameCut Worker' -Action $action -Trigger $trigger -Description 'FrameCut GPU Worker' -Force | Out-Null
}
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Write-Host "`nFrameCut Worker ($($registration.workerId)) wurde eingerichtet." -ForegroundColor Green
