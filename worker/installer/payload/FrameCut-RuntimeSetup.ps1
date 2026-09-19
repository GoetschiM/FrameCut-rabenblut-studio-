[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ServerUrl,
    [Parameter(Mandatory=$true)][string]$WorkerRoot,
    [Parameter(Mandatory=$true)][string]$WorkerId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Info([string]$Text) { Write-Host "  $Text" -ForegroundColor Gray }
function Resolve-Pterm {
    $candidates = @(
        (Join-Path $env:USERPROFILE 'Documents\Pinokio\bin\npm\pterm.cmd'),
        (Join-Path $env:LOCALAPPDATA 'Pinokio\bin\npm\pterm.cmd')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    return $null
}
function Get-PinokioInstallerUrl {
    $page = Invoke-WebRequest -Uri 'https://desktop.pinokio.co/download.html' -UseBasicParsing -TimeoutSec 30
    $match = [regex]::Match($page.Content, 'https://github\.com/pinokiocomputer/pinokio/releases/download/[^"''\s]+/Pinokio\.exe')
    if (-not $match.Success) { throw 'Die offizielle Pinokio-Download-URL konnte nicht ermittelt werden.' }
    return $match.Value
}

Write-Host "`nFrameCut Runtime-Setup (Worker $WorkerId)" -ForegroundColor Cyan
$pterm = Resolve-Pterm
if (-not $pterm) {
    Info 'Pinokio wurde auf diesem Benutzerprofil noch nicht gefunden.'
    $installer = Join-Path $env:TEMP 'Pinokio-FrameCut.exe'
    $url = Get-PinokioInstallerUrl
    Info 'Offiziellen Pinokio-Installer herunterladen ...'
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing -TimeoutSec 300
    Start-Process -FilePath $installer -Wait
    $pterm = Resolve-Pterm
    if (-not $pterm) {
        throw 'Pinokio wurde installiert, ist aber noch nicht initialisiert. Starte Pinokio einmal und führe den FrameCut-Installer danach erneut aus.'
    }
}

$pinokioHome = Split-Path (Split-Path (Split-Path $pterm -Parent) -Parent) -Parent
$appPath = Join-Path $pinokioHome 'api\minimax-h3-pinokio.git'
if (-not (Test-Path -LiteralPath $appPath)) {
    Info 'MiniMax-H3-Pinokio-App herunterladen ...'
    & $pterm download 'https://github.com/ThomasEricB/minimax-h3-pinokio.git' 'minimax-h3-pinokio.git'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $appPath)) {
        throw 'MiniMax-H3-App konnte über Pinokio nicht heruntergeladen werden.'
    }
}

Info 'MiniMax-H3 installieren/starten (Modelle können viele GB benötigen) ...'
& $pterm run $appPath --default install.js
if ($LASTEXITCODE -ne 0) { throw "Pinokio meldete einen Fehler beim MiniMax-H3-Setup (ExitCode $LASTEXITCODE)." }
Info 'Pinokio/MiniMax-H3 ist eingerichtet.'
