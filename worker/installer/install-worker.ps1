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
    # The worker is deliberately scheduled as LocalSystem so it survives logoff.
    # CurrentUser DPAPI would encrypt for the elevated installer account and fail at
    # the first unattended start. LocalMachine keeps the secret bound to this PC.
    $cipher = [Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    [Convert]::ToBase64String($cipher)
}
function Gpu-Info {
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    $line = $null
    if ($smi) { try { $line = (& $smi.Source '--query-gpu=name,driver_version,memory.total' '--format=csv,noheader' 2>$null | Select-Object -First 1).Trim() } catch {} }
    [ordered]@{ nvidiaSmi = [bool]$smi; description = $line }
}

function Read-WithDefault([string]$Prompt, [string]$Default) {
    $answer = Read-Host "$Prompt [Enter = $Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Test-JoinCode([string]$Code) {
    return $Code.Trim().ToUpperInvariant() -match '^FC-[A-Z0-9]{6,40}$'
}

function Invoke-Register([string]$Uri, [string]$Body) {
    try {
        return Invoke-RestMethod -Uri $Uri -Method Post -ContentType 'application/json' -Body $Body -TimeoutSec 30
    } catch {
        $detail = $_.Exception.Message
        try {
            if ($_.Exception.Response) {
                $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
                $text = $reader.ReadToEnd()
                if ($text) { $detail = "$detail — $text" }
            }
        } catch {}
        throw $detail
    }
}

Require-Admin
$defaultServer = 'http://10.0.60.131:4317'
if (-not $ServerUrl) { $ServerUrl = Read-WithDefault 'FrameCut-Adresse' $defaultServer }
$defaultName = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'Gaming-PC' }
if (-not $WorkerName) { $WorkerName = Read-WithDefault 'Worker-Name' $defaultName }
$ServerUrl = $ServerUrl.Trim().TrimEnd('/')
if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl muss mit http:// oder https:// beginnen.' }

Step 'Verbindung zum FrameCut-Server testen'
try {
    $manifestResponse = Invoke-WebRequest -Uri "$ServerUrl/api/worker/installer/manifest" -UseBasicParsing -TimeoutSec 20
} catch {
    throw "FrameCut-Server nicht erreichbar oder Installer-Endpunkt noch nicht deployed: $ServerUrl`nDetails: $($_.Exception.Message)"
}
Step 'Installer-Manifest vom FrameCut-Server laden'
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

Step 'Netzwerk prüfen (Tailscale ist optional)'
$localNetworkOk = $false
try {
    $probe = Test-NetConnection -ComputerName ([uri]$ServerUrl).Host -Port ([uri]$ServerUrl).Port -WarningAction SilentlyContinue -InformationLevel Quiet
    $localNetworkOk = [bool]$probe
} catch { $localNetworkOk = $false }
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if ($localNetworkOk) {
    Write-Host 'Lokales Netzwerk zum FrameCut-Server ist erreichbar. Tailscale wird nicht benötigt.' -ForegroundColor Green
} elseif ($tailscale) {
    Write-Warning 'Lokales Netzwerk nicht erreichbar. Tailscale kann als optionaler Fallback helfen.'
} else {
    Write-Warning 'Server nicht lokal erreichbar und Tailscale ist nicht installiert.'
}

if (-not $JoinCode) {
    Write-Host "`nDer Registrierungscode ist KEINE beliebige PIN." -ForegroundColor Yellow
    Write-Host 'Erzeuge ihn in FrameCut unter Worker -> Neuen Join-Code erzeugen.'
    Write-Host 'Er beginnt mit FC- und ist nur einmalig verwendbar.'
    $JoinCode = Read-Host 'Einmaligen FrameCut-Registrierungscode eingeben'
}
if ([string]::IsNullOrWhiteSpace($JoinCode)) { throw 'Registrierungscode fehlt. Bitte einen FC-... Join-Code aus FrameCut verwenden.' }
$JoinCode = $JoinCode.Trim().ToUpperInvariant()
if (-not (Test-JoinCode $JoinCode)) { throw "Ungültiger Registrierungscode '$JoinCode'. Erwartet wird ein einmaliger Code im Format FC-... (nicht 1234)." }
$gpuJson = $gpu | ConvertTo-Json -Depth 3
$body = [ordered]@{ joinCode=$JoinCode; name=$WorkerName; machine=$env:COMPUTERNAME; os='windows'; architecture=$env:PROCESSOR_ARCHITECTURE; gpu=$gpu; capabilities=@('bootstrap'); installerVersion='phase1' } | ConvertTo-Json -Depth 6

Step 'Worker registrieren'
$registration = Invoke-Register "$ServerUrl/api/worker/register" $body
if (-not $registration.workerId -or -not $registration.workerToken) { throw 'Registrierung lieferte keine Worker-Zugangsdaten.' }

$root = Join-Path $env:ProgramData 'FrameCut\Worker'
$versionRoot = Join-Path $root "versions\$($manifest.version)"
New-Item -ItemType Directory -Path $versionRoot -Force | Out-Null
$zip = Join-Path $env:TEMP "framecut-worker-$($manifest.version).zip"
Step "Worker $($manifest.version) herunterladen und prüfen"
$downloadHeaders = @{ 'x-framecut-worker'=$registration.workerToken; 'x-framecut-worker-id'=$registration.workerId }
Invoke-WebRequest -Uri $manifest.downloadUrl -Headers $downloadHeaders -OutFile $zip -UseBasicParsing -TimeoutSec 300
$actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $manifest.sha256.ToString().ToLowerInvariant()) { throw "SHA-256-Prüfung fehlgeschlagen: $actual" }
Expand-Archive -LiteralPath $zip -DestinationPath $versionRoot -Force

$config = [ordered]@{ serverUrl=$ServerUrl; workerId=$registration.workerId; workerName=$WorkerName; workerTokenProtected=(Protect-Token $registration.workerToken); version=$manifest.version; installedAt=(Get-Date).ToUniversalTime().ToString('o'); runtimeState='awaiting_runtime' }
$config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'worker.json') -Encoding UTF8

$runtimeSetup = Join-Path $versionRoot 'FrameCut-RuntimeSetup.ps1'
if (-not (Test-Path -LiteralPath $runtimeSetup)) {
    # Keep the guided setup usable while an older server release is still live.
    # The desktop bundle carries the same runtime helper under payload\.
    $localRuntimeSetup = Join-Path $PSScriptRoot 'payload\FrameCut-RuntimeSetup.ps1'
    if (Test-Path -LiteralPath $localRuntimeSetup) { $runtimeSetup = $localRuntimeSetup }
}
if (Test-Path -LiteralPath $runtimeSetup) {
    Step 'Pinokio und benötigte Runtime automatisch einrichten'
    try {
        & PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeSetup -ServerUrl $ServerUrl -WorkerRoot $root -WorkerId $registration.workerId
        if ($LASTEXITCODE -eq 0) {
            $config.runtimeState = 'runtime_ready'
            $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'worker.json') -Encoding UTF8
        }
    } catch {
        Write-Warning "Runtime-Setup noch nicht abgeschlossen: $($_.Exception.Message)"
        Write-Host 'Der Worker bleibt registriert und versucht weiterhin den Bootstrap-Heartbeat.' -ForegroundColor Yellow
    }
}
$entrypoint = Join-Path $versionRoot $manifest.entrypoint
if (Test-Path -LiteralPath $entrypoint) {
    Step 'Worker-Autostart einrichten'
    # The published entrypoint is a .bat launcher, which avoids fragile quoting for
    # PowerShell scripts and lets the task run independently of an interactive login.
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$entrypoint`"" -WorkingDirectory (Split-Path $entrypoint)
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName 'FrameCut Worker' -Action $action -Trigger $trigger -Principal $principal -Description 'FrameCut GPU Worker' -Force | Out-Null
    Start-ScheduledTask -TaskName 'FrameCut Worker'
}
Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
Write-Host "`nFrameCut Worker ($($registration.workerId)) wurde eingerichtet." -ForegroundColor Green
