[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServerUrl,
    [Parameter(Mandatory=$true)][string]$WorkerRoot,
    [Parameter(Mandatory=$true)][string]$WorkerId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Info([string]$Text) { Write-Host "  $Text" -ForegroundColor Gray }
function Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }

function Resolve-PinokioHome {
    $pinokioCfg = Join-Path $env:USERPROFILE '.pinokio\config.json'
    if (Test-Path -LiteralPath $pinokioCfg) {
        try {
            $cfg = Get-Content -LiteralPath $pinokioCfg -Raw | ConvertFrom-Json
            if ($cfg.home -and (Test-Path -LiteralPath $cfg.home)) { return $cfg.home }
        } catch {}
    }
    $candidates = @(
        (Join-Path $env:USERPROFILE 'Documents\Pinokio'),
        (Join-Path $env:LOCALAPPDATA 'Pinokio'),
        'C:\Pinokio', 'D:\Pinokio', 'E:\Pinokio'
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $c 'bin\npm\pterm.cmd')) { return $c }
    }
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return (Join-Path $env:USERPROFILE 'Documents\Pinokio')
}

function Resolve-Pterm([string]$HomePath) {
    $pterm = Join-Path $HomePath 'bin\npm\pterm.cmd'
    if (Test-Path -LiteralPath $pterm) { return $pterm }
    $alt = Join-Path $env:LOCALAPPDATA 'Pinokio\bin\npm\pterm.cmd'
    if (Test-Path -LiteralPath $alt) { return $alt }
    return $null
}

function Get-PinokioInstallerUrl {
    try {
        $page = Invoke-WebRequest -Uri 'https://desktop.pinokio.co/download.html' -UseBasicParsing -TimeoutSec 15
        $match = [regex]::Match($page.Content, 'https://github\.com/pinokiocomputer/pinokio/releases/download/[^"''\s]+/Pinokio\.exe')
        if ($match.Success) { return $match.Value }
    } catch {}
    return 'https://github.com/pinokiocomputer/pinokio/releases/download/v8.2.0/Pinokio.exe'
}

Step "FrameCut Runtime-Setup (Worker $WorkerId)"

$pinokioHome = Resolve-PinokioHome
$pterm = Resolve-Pterm $pinokioHome

if (-not $pterm) {
    Write-Host "Pinokio wurde auf diesem System noch nicht vollständig eingerichtet." -ForegroundColor Yellow
    $installer = Join-Path $env:TEMP 'Pinokio-FrameCut.exe'
    $url = Get-PinokioInstallerUrl
    Info "Offiziellen Pinokio-Installer herunterladen: $url ..."
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 300
    Info "Pinokio-Installer wird gestartet ..."
    Start-Process -FilePath $installer -Wait

    # Warte auf Benutzerinteraktion zur Ersteinrichtung
    Write-Host "`n"
    Write-Host "==========================================================================" -ForegroundColor Yellow
    Write-Host " [WICHTIG] Pinokio Ersteinrichtung abschliessen:" -ForegroundColor Yellow
    Write-Host " 1. Öffne Pinokio (falls es nicht bereits geöffnet ist)." -ForegroundColor Yellow
    Write-Host " 2. Wähle im Pinokio-Assistenten das gewünschte Datenlaufwerk" -ForegroundColor Yellow
    Write-Host "    (empfohlen: mindestens 80-100 GB freier Speicherplatz)." -ForegroundColor Yellow
    Write-Host " 3. Warte kurz, bis Pinokio die Grundkomponenten (Node/Git) geladen hat." -ForegroundColor Yellow
    Write-Host " 4. Drücke anschliessend hier die ENTER-Taste, um fortzufahren." -ForegroundColor Yellow
    Write-Host "==========================================================================" -ForegroundColor Yellow
    [void](Read-Host "Drücke ENTER, wenn Pinokio geöffnet und initialisiert ist")

    for ($i = 0; $i -lt 10; $i++) {
        $pinokioHome = Resolve-PinokioHome
        $pterm = Resolve-Pterm $pinokioHome
        if ($pterm) { break }
        Start-Sleep -Seconds 2
    }

    if (-not $pterm) {
        throw "Pinokio/pterm wurde unter '$pinokioHome' noch nicht gefunden. Bitte Pinokio einmal starten und initialisieren lassen, danach den Installer erneut ausführen."
    }
}

Info "Pinokio-Home erkannt: $pinokioHome"
Info "pterm-Befehl: $pterm"

# 1. MiniMax-H3 App-Repository prüfen / klonen
$appPath = Join-Path $pinokioHome 'api\minimax-h3-pinokio.git'
if (-not (Test-Path -LiteralPath $appPath)) {
    Step "MiniMax-H3 Pinokio-App herunterladen"
    & $pterm download 'https://github.com/ThomasEricB/minimax-h3-pinokio.git' 'minimax-h3-pinokio.git'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $appPath)) {
        throw "MiniMax-H3-App konnte über Pinokio nicht heruntergeladen werden."
    }
}

# 2. Modellprüfung (alle Dateien des von FrameCut verwendeten Workflows)
$requiredModels = @(
    'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    'minimax_h3_video_vae_fp16.safetensors',
    'minimax_h3_audio_vae_fp32.safetensors',
    'minimax_h3_turbo_v4_step600_ema.safetensors'
)
function Find-H3Model([string]$Name) {
    $local = Get-ChildItem -Path (Join-Path $appPath 'app\models') -Filter $Name -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($local) { return $local.FullName }
    $drivePath = Join-Path $pinokioHome 'drive'
    if (Test-Path -LiteralPath $drivePath) {
        $shared = Get-ChildItem -Path $drivePath -Filter $Name -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($shared) { return $shared.FullName }
    }
    return $null
}
$missingModels = @($requiredModels | Where-Object { -not (Find-H3Model $_) })
$modelReady = $missingModels.Count -eq 0

if (-not $modelReady) {
    Step "MiniMax-H3 Modellinstallation vorbereiten"
    $driveRoot = [IO.Path]::GetPathRoot($pinokioHome).TrimEnd('\')
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$driveRoot'" -ErrorAction SilentlyContinue
    if ($disk -and $disk.FreeSpace) {
        $freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
        if ($freeGb -lt 70) {
            Write-Warning "Auf Laufwerk $driveRoot sind nur $freeGb GB frei. MiniMax H3 benötigt für vollständige Modelle ca. 65 GB."
        } else {
            Info "Freier Speicherplatz auf ${driveRoot}: $freeGb GB (ausreichend)."
        }
    }

    Write-Host "Die MiniMax H3-Modelle (ca. 60-65 GB) werden nun über Pinokio eingerichtet." -ForegroundColor Cyan
    Write-Host "Dies kann je nach Internetverbindung einige Zeit in Anspruch nehmen..." -ForegroundColor Gray

    & $pterm run $appPath --default install.js
    if ($LASTEXITCODE -ne 0) {
        throw "Pinokio meldete einen Fehler beim MiniMax-H3-Setup (ExitCode $LASTEXITCODE)."
    }
} else {
    Write-Host "Alle von FrameCut benötigten MiniMax-H3-Modelle sind bereits vorhanden." -ForegroundColor Green
}

$missingModels = @($requiredModels | Where-Object { -not (Find-H3Model $_) })
if ($missingModels.Count) {
    throw "MiniMax-H3-Installation unvollständig. Es fehlen: $($missingModels -join ', ')"
}
foreach ($model in $requiredModels) { Info "Modell geprüft: $model" }

# 3. Python und Umgebung prüfen
$miniforgePython = Join-Path $pinokioHome 'bin\miniforge\python.exe'
if (Test-Path -LiteralPath $miniforgePython) {
    Info "Pinokio Miniforge Python: $miniforgePython"
}

Step "Runtime-Setup erfolgreich abgeschlossen"
