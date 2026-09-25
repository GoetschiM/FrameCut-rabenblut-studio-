[CmdletBinding()]
param(
    [string]$ServerUrl = $env:FRAMECUT_SERVER_URL,
    [string]$JoinCode = $env:FRAMECUT_JOIN_CODE,
    [string]$WorkerName = $env:FRAMECUT_WORKER_NAME,
    [switch]$SkipRuntime,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step([string]$Text) { Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Success([string]$Text) { Write-Host "[OK] $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "[WARN] $Text" -ForegroundColor Yellow }
function Info([string]$Text) { Write-Host "  $Text" -ForegroundColor Gray }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FrameCutInstallerPower {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint flags);
}
'@
function Set-InstallerAwake([bool]$Enabled) {
    $continuous = 0x80000000
    $systemRequired = 0x00000001
    $value = if ($Enabled) { $continuous -bor $systemRequired } else { $continuous }
    [void][FrameCutInstallerPower]::SetThreadExecutionState($value)
}

function Read-WithDefault([string]$Prompt, [string]$Default) {
    $answer = Read-Host "$Prompt [Enter = $Default]"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
    return $answer.Trim()
}

function Require-Admin {
    $p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Host "Administratorrechte werden für die Registrierung benötigt. UAC wird angefordert..." -ForegroundColor Yellow
        $argList = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
        if ($ServerUrl) { $argList += @('-ServerUrl', "`"$ServerUrl`"") }
        if ($JoinCode) { $argList += @('-JoinCode', "`"$JoinCode`"") }
        if ($WorkerName) { $argList += @('-WorkerName', "`"$WorkerName`"") }
        if ($SkipRuntime) { $argList += '-SkipRuntime' }
        if ($NoStart) { $argList += '-NoStart' }

        $proc = Start-Process PowerShell.exe -Verb RunAs -ArgumentList $argList -PassThru -Wait
        exit $proc.ExitCode
    }
}

function Protect-WorkerToken([string]$Token) {
    Add-Type -AssemblyName System.Security
    $raw = [Text.Encoding]::Unicode.GetBytes($Token)
    $cipher = [Security.Cryptography.ProtectedData]::Protect($raw, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return ($cipher | ForEach-Object { $_.ToString('x2') }) -join ''
}
function Read-WorkerToken([string]$Path) {
    $hex = (Get-Content -LiteralPath $Path -Raw).Trim()
    $bytes = New-Object byte[] ($hex.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    return [Text.Encoding]::Unicode.GetString($plain)
}

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
    } finally { $stream.Dispose() }
}

function Stop-InstalledWorker([string]$Root) {
    $pidPath = Join-Path $Root 'data\worker.pid'
    $stopPath = Join-Path $Root 'data\worker.stop'
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    $workerPid = 0
    [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$workerPid) | Out-Null
    if ($workerPid -le 0) { return }
    $process = Get-Process -Id $workerPid -ErrorAction SilentlyContinue
    if (-not $process) { return }
    $commandLine = ''
    try { $commandLine = [string](Get-CimInstance Win32_Process -Filter "ProcessId=$workerPid").CommandLine } catch {}
    if ($commandLine -notmatch 'FrameCut-Worker\.ps1') {
        Warn "PID $workerPid gehört nicht eindeutig zum FrameCut-Worker und wird nicht beendet."
        return
    }
    Step 'Laufenden alten Worker sauber stoppen'
    Set-Content -LiteralPath $stopPath -Value 'installer-update' -Encoding ascii
    for ($second=0; $second -lt 25; $second++) {
        if (-not (Get-Process -Id $workerPid -ErrorAction SilentlyContinue)) { Success 'Alter Worker wurde sauber beendet.'; return }
        Start-Sleep -Seconds 1
    }
    Warn 'Alter Worker reagiert nicht auf das Stoppsignal und wird kontrolliert beendet.'
    Stop-Process -Id $workerPid -Force -ErrorAction Stop
}

function Gpu-Info {
    $smi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    $line = $null
    if ($smi) {
        try {
            $line = (& $smi.Source '--query-gpu=name,driver_version,memory.total' '--format=csv,noheader' 2>$null | Select-Object -First 1).Trim()
        } catch {}
    }
    [ordered]@{ nvidiaSmi = [bool]$smi; description = $line }
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
                $stream = $_.Exception.Response.GetResponseStream()
                $reader = New-Object System.IO.StreamReader($stream)
                $text = $reader.ReadToEnd()
                if ($text) { $detail = "$detail - $text" }
            }
        } catch {}
        throw $detail
    }
}

try {
    Require-Admin
    Set-InstallerAwake $true

    Write-Host "==========================================================================" -ForegroundColor Cyan
    Write-Host "                  FrameCut Worker Setup und Installer                     " -ForegroundColor Cyan
    Write-Host "==========================================================================" -ForegroundColor Cyan

    $workerInstallRoot = Join-Path $env:ProgramData 'FrameCut\Worker'
    New-Item -ItemType Directory -Path $workerInstallRoot -Force | Out-Null
    try {
        $acl = Get-Acl -LiteralPath $workerInstallRoot
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule('Users', 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $workerInstallRoot -AclObject $acl
    } catch {}

    $configPath = Join-Path $workerInstallRoot 'data\worker.config.json'
    $tokenPath = Join-Path $workerInstallRoot 'data\worker-token.dpapi'
    $existingConfig = $null
    $skipRegistration = $false

    if (Test-Path -LiteralPath $configPath) {
        try {
            $existingConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        } catch {}
    }

    Stop-InstalledWorker $workerInstallRoot

    $defaultServer = if ($existingConfig -and $existingConfig.ServerUrl) { $existingConfig.ServerUrl } else { 'http://10.0.60.131:4317' }
    if (-not $ServerUrl) { $ServerUrl = Read-WithDefault 'FrameCut-Server-Adresse' $defaultServer }
    $ServerUrl = $ServerUrl.Trim().TrimEnd('/')
    if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl muss mit http:// oder https:// beginnen.' }

    $defaultName = if ($existingConfig -and $existingConfig.WorkerName) { $existingConfig.WorkerName } elseif ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'Gaming-PC' }
    if (-not $WorkerName) { $WorkerName = Read-WithDefault 'Worker-Name' $defaultName }

    Step 'GPU und lokalen Speicher prüfen'
    $gpu = Gpu-Info
    if ($gpu.nvidiaSmi -and $gpu.description) {
        Success "NVIDIA GPU erkannt: $($gpu.description)"
    } elseif ($gpu.nvidiaSmi) {
        Success 'nvidia-smi vorhanden.'
    } else {
        Warn 'nvidia-smi wurde nicht gefunden. Ein NVIDIA-Grafiktreiber muss vor dem Rendern installiert sein.'
    }

    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'"
    $freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
    if ($freeGb -lt 75) {
        Warn "Auf $($env:SystemDrive) sind nur $freeGb GB frei. MiniMax H3 benötigt für vollständige Modelle ca. 65-75 GB."
    } else {
        Success "$freeGb GB freier Speicher auf $($env:SystemDrive)."
    }

    Step 'Verbindung zum FrameCut-Server prüfen'
    $manifest = $null
    try {
        $manifestResponse = Invoke-WebRequest -Uri "$ServerUrl/api/worker/installer/manifest" -UseBasicParsing -TimeoutSec 15
        $manifest = $manifestResponse.Content | ConvertFrom-Json
    } catch {
        Warn "Server-Manifest unter $ServerUrl/api/worker/installer/manifest konnte nicht geladen werden: $($_.Exception.Message)"
        Info "Lokales Fallback-Paket wird genutzt."
    }

    $workerId = $null
    $workerToken = $null

    if ($existingConfig -and $existingConfig.WorkerId -and (Test-Path -LiteralPath $tokenPath)) {
        Write-Host "`nDieser Computer ist bereits als '$($existingConfig.WorkerId)' registriert." -ForegroundColor Green
        $reuse = Read-WithDefault "Bestehende Registrierung beibehalten? (J/n)" "J"
        if ($reuse -notmatch '^[nN]') {
            $skipRegistration = $true
            $workerId = $existingConfig.WorkerId
            Info "Bestehende Registrierung wird übernommen."
        }
    }

    if (-not $skipRegistration) {
        Step 'Registrierung am FrameCut-Server'
        if (-not $JoinCode) {
            Write-Host "`nDer Registrierungscode ist ein einmaliger Token aus FrameCut:" -ForegroundColor Yellow
            Write-Host "  -> Öffne FrameCut im Browser -> Worker -> 'Neuen Join-Code erzeugen'." -ForegroundColor Yellow
            Write-Host "  -> Er beginnt mit FC- und ist z. B. FC-A1B2C3D4." -ForegroundColor Yellow
            do {
                $JoinCode = Read-Host "`nEinmaligen Registrierungscode eingeben"
                if ($JoinCode) { $JoinCode = $JoinCode.Trim().ToUpperInvariant() }
                if (-not (Test-JoinCode $JoinCode)) {
                    Warn "Ungültiges Format '$JoinCode'. Erwartet wird ein Code wie FC-ABC12345."
                    $retry = Read-WithDefault "Erneut versuchen? (J/n)" "J"
                    if ($retry -match '^[nN]') { throw "Registrierung ohne gültigen Join-Code abgebrochen." }
                }
            } while (-not (Test-JoinCode $JoinCode))
        }

        $body = [ordered]@{
            joinCode = $JoinCode
            name = $WorkerName
            machine = $env:COMPUTERNAME
            os = 'windows'
            architecture = $env:PROCESSOR_ARCHITECTURE
            gpu = $gpu
            capabilities = @('minimax-h3', 'comfyui', 'qwen-tts', 'stable-audio')
            installerVersion = 'phase2-hardened'
        } | ConvertTo-Json -Depth 6

        Info "Registriere Worker '$WorkerName' an $ServerUrl..."
        $registration = Invoke-Register "$ServerUrl/api/worker/register" $body
        if (-not $registration.workerId -or -not $registration.workerToken) {
            throw 'Registrierung lieferte keine Worker-Zugangsdaten.'
        }
        $workerId = $registration.workerId
        $workerToken = $registration.workerToken
        Success "Erfolgreich registriert als $workerId"
    }

    Step 'Worker-Dateien bereitstellen'
    # New installs and reruns must use the exact server release, rather than
    # silently copying whatever installer bundle happened to be started.
    $packageRoot = $null
    if ($manifest -and $manifest.downloadUrl -and $manifest.sha256) {
        try {
            $effectiveToken = if ($workerToken) { $workerToken } elseif (Test-Path -LiteralPath $tokenPath) { Read-WorkerToken $tokenPath } else { $null }
            if (-not $effectiveToken) { throw 'Kein Worker-Token für den Paketdownload vorhanden.' }
            $downloadRoot = Join-Path $env:TEMP ('framecut-worker-' + [guid]::NewGuid().ToString('N'))
            $archive = Join-Path $downloadRoot 'worker.zip'
            $packageRoot = Join-Path $downloadRoot 'package'
            New-Item -ItemType Directory -Force -Path $packageRoot | Out-Null
            $headers = @{ 'x-framecut-worker' = $effectiveToken; 'x-framecut-worker-id' = $workerId }
            Invoke-WebRequest -Uri $manifest.downloadUrl -Headers $headers -OutFile $archive -UseBasicParsing -TimeoutSec 180
            $actualHash = Get-Sha256 $archive
            if ($actualHash -ne ([string]$manifest.sha256).ToLowerInvariant()) { throw 'Die SHA-256-Prüfsumme des Worker-Pakets stimmt nicht.' }
            Expand-Archive -LiteralPath $archive -DestinationPath $packageRoot -Force
            if (-not (Test-Path -LiteralPath (Join-Path $packageRoot $manifest.entrypoint))) { throw 'Das Server-Paket enthält den erwarteten Worker-Einstieg nicht.' }
            Success "Server-Paket $($manifest.version) geprüft und entpackt."
        } catch {
            Warn "Server-Paket konnte nicht verwendet werden: $($_.Exception.Message)"
            $packageRoot = $null
        }
    }
    # Quelle prüfen: Lokales Bundle oder Download
    $localPayload = Join-Path $PSScriptRoot 'payload'
    $repoWorkerDir = Join-Path $PSScriptRoot '..\..\worker'
    if (-not (Test-Path -LiteralPath $repoWorkerDir)) { $repoWorkerDir = $PSScriptRoot }

    # Kopiere Hauptdateien
    $sourceFiles = @(
        'FrameCut-Worker.ps1',
        'FrameCut-Worker.bat',
        'FrameCut-Worker-stoppen.bat',
        'FrameCut-Worker-Update.ps1',
        'worker.version.json',
        'framecut_qwen_tts.py',
        'framecut_stable_audio.py'
    )

    foreach ($file in $sourceFiles) {
        $src = $null
        if ($packageRoot -and (Test-Path -LiteralPath (Join-Path $packageRoot $file))) { $src = Join-Path $packageRoot $file }
        elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file)) { $src = Join-Path $PSScriptRoot $file }
        elseif (Test-Path -LiteralPath (Join-Path $repoWorkerDir $file)) { $src = Join-Path $repoWorkerDir $file }
        elseif (Test-Path -LiteralPath (Join-Path $localPayload $file)) { $src = Join-Path $localPayload $file }

        if ($src) {
            Copy-Item -LiteralPath $src -Destination (Join-Path $workerInstallRoot $file) -Force
        }
    }

    # Kopiere Adapter
    $adaptersDir = Join-Path $workerInstallRoot 'adapters'
    New-Item -ItemType Directory -Path $adaptersDir -Force | Out-Null
    $srcAdapters = $null
    if ($packageRoot -and (Test-Path -LiteralPath (Join-Path $packageRoot 'adapters'))) { $srcAdapters = Join-Path $packageRoot 'adapters' }
    elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'adapters')) { $srcAdapters = Join-Path $PSScriptRoot 'adapters' }
    elseif (Test-Path -LiteralPath (Join-Path $repoWorkerDir 'adapters')) { $srcAdapters = Join-Path $repoWorkerDir 'adapters' }

    if ($srcAdapters) {
        Copy-Item -LiteralPath (Join-Path $srcAdapters '*') -Destination $adaptersDir -Recurse -Force
        Success 'Adapter (MiniMax H3, ComfyUI, Qwen TTS) kopiert.'
    }

    # Kopiere Runtime-Setup ins Ziel
    $runtimeSetupSrc = $null
    if ($packageRoot -and (Test-Path -LiteralPath (Join-Path $packageRoot 'FrameCut-RuntimeSetup.ps1'))) { $runtimeSetupSrc = Join-Path $packageRoot 'FrameCut-RuntimeSetup.ps1' }
    elseif (Test-Path -LiteralPath (Join-Path $localPayload 'FrameCut-RuntimeSetup.ps1')) { $runtimeSetupSrc = Join-Path $localPayload 'FrameCut-RuntimeSetup.ps1' }
    elseif (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'FrameCut-RuntimeSetup.ps1')) { $runtimeSetupSrc = Join-Path $PSScriptRoot 'FrameCut-RuntimeSetup.ps1' }

    if ($runtimeSetupSrc) {
        Copy-Item -LiteralPath $runtimeSetupSrc -Destination (Join-Path $workerInstallRoot 'FrameCut-RuntimeSetup.ps1') -Force
    }

    Step 'Worker-Konfiguration und Token anlegen'
    $runtimeDataDir = Join-Path $workerInstallRoot 'data'
    New-Item -ItemType Directory -Path $runtimeDataDir -Force | Out-Null

    $configObj = [ordered]@{
        ServerUrl = $ServerUrl
        WorkerId = $workerId
        WorkerName = $WorkerName
        H3Ref = 'minimax-h3-pinokio.git'
        H3Url = 'http://127.0.0.1:8188'
        UseH3ReferenceConditioning = $false
        H3ReferenceImageSize = 'match'
        StripAudio = $true
        AutoUpdate = $true
        UpdateCheckSeconds = 300
        WorkerVersion = if ($manifest -and $manifest.version) { [string]$manifest.version } else { 'local' }
        InstalledAt = (Get-Date).ToUniversalTime().ToString('o')
    }

    $configObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtimeDataDir 'worker.config.json') -Encoding UTF8

    if ($workerToken) {
        $protectedHex = Protect-WorkerToken $workerToken
        Set-Content -LiteralPath (Join-Path $runtimeDataDir 'worker-token.dpapi') -Value $protectedHex -Encoding ascii
    }

    Success "Konfiguration gespeichert in $workerInstallRoot\data"

    if (-not $SkipRuntime) {
        $runtimeSetup = Join-Path $workerInstallRoot 'FrameCut-RuntimeSetup.ps1'
        if (Test-Path -LiteralPath $runtimeSetup) {
            Step 'Pinokio & Modelle überprüfen'
            try {
                & PowerShell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $runtimeSetup -ServerUrl $ServerUrl -WorkerRoot $workerInstallRoot -WorkerId $workerId
            } catch {
                Warn "Runtime-Setup meldete einen Hinweis: $($_.Exception.Message)"
            }
        }
    }

    Step 'Desktop-Verknüpfungen erstellen'
    $desktopPath = [Environment]::GetFolderPath('Desktop')
    if (-not $desktopPath) { $desktopPath = Join-Path $env:USERPROFILE 'Desktop' }

    $startLines = @(
        '@echo off',
        'title FrameCut Worker - aktiv',
        "cd /d `"$workerInstallRoot`"",
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$workerInstallRoot\FrameCut-Worker.ps1`"",
        'pause'
    )
    Set-Content -LiteralPath (Join-Path $desktopPath 'FrameCut Worker starten.bat') -Value $startLines -Encoding ascii

    $stopLines = @(
        '@echo off',
        'title FrameCut Worker stoppen',
        "cd /d `"$workerInstallRoot`"",
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$workerInstallRoot\FrameCut-Worker.ps1`" -Stop",
        "if exist `"$workerInstallRoot\data\worker.pid`" del `"$workerInstallRoot\data\worker.pid`"",
        'echo FrameCut Worker Stopp-Signal gesendet.',
        'timeout /t 3'
    )
    Set-Content -LiteralPath (Join-Path $desktopPath 'FrameCut Worker stoppen.bat') -Value $stopLines -Encoding ascii

    Success "Desktop-Icons 'FrameCut Worker starten.bat' und 'FrameCut Worker stoppen.bat' angelegt."

    Step 'Benutzer-Autostart einrichten'
    try {
        $taskName = 'FrameCut User Worker'
        $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$workerInstallRoot\FrameCut-Worker.bat`"`"" -WorkingDirectory $workerInstallRoot
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description 'FrameCut GPU Worker (User Session)' -Force | Out-Null
        Success "Windows Autostart für Benutzer '$($env:USERNAME)' eingerichtet (mit vollem GPU-Zugriff)."
    } catch {
        Warn "Autostart-Task konnte nicht registriert werden: $($_.Exception.Message). Der Worker kann jederzeit über den Desktop gestartet werden."
    }

    if (-not $NoStart) {
        Step 'Aktuellen FrameCut-Worker starten'
        $workerEntrypoint = Join-Path $workerInstallRoot 'FrameCut-Worker.bat'
        if (-not (Test-Path -LiteralPath $workerEntrypoint)) { throw "Worker-Startdatei fehlt: $workerEntrypoint" }
        Start-Process -FilePath $workerEntrypoint -WorkingDirectory $workerInstallRoot
        Success 'Worker wurde gestartet und meldet sich jetzt am FrameCut-Server.'
    }

    Write-Host ""
    Write-Host "==========================================================================" -ForegroundColor Green
    Write-Host "      FrameCut Worker ($workerId) ist einsatzbereit!                     " -ForegroundColor Green
    Write-Host "==========================================================================" -ForegroundColor Green
    Write-Host "Der Worker wurde gestartet. Spaeter kannst du ihn ueber das Desktop-Icon erneut starten." -ForegroundColor Cyan
    Write-Host ""
    Set-InstallerAwake $false

} catch {
    Set-InstallerAwake $false
    Write-Host ""
    Write-Host "==========================================================================" -ForegroundColor Red
    Write-Host " FEHLER BEIM INSTALLIEREN DES WORKERS:" -ForegroundColor Red
    Write-Host " $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "==========================================================================" -ForegroundColor Red
    Write-Host "Details zum Fehler:" -ForegroundColor DarkGray
    Write-Host ($_.ScriptStackTrace) -ForegroundColor DarkGray
    [void](Read-Host 'Druecke ENTER, um das Fenster zu schliessen')
    exit 1
}
