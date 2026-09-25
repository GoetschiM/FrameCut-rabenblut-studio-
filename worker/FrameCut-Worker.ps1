param([switch]$Once)

$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $workerRoot 'data'
$configPath = Join-Path $runtimeRoot 'worker.config.json'
$tokenPath = Join-Path $runtimeRoot 'worker-token.dpapi'
$pidPath = Join-Path $runtimeRoot 'worker.pid'
$stopPath = Join-Path $runtimeRoot 'worker.stop'
# PowerShell 5.1 reuses pooled keep-alive sockets that the Node server closed during long ffmpeg/H3 work ("Verbindung ... geschlossen").
$PSDefaultParameterValues['Invoke-RestMethod:DisableKeepAlive']=$true
$PSDefaultParameterValues['Invoke-WebRequest:DisableKeepAlive']=$true
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

$pinokioHome = Resolve-PinokioHome
$pterm = Join-Path $pinokioHome 'bin\npm\pterm.cmd'

if(-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $tokenPath)){Write-Host 'Worker ist noch nicht eingerichtet. Bitte Setup erneut ausfuehren.' -ForegroundColor Yellow;exit 1}
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
$versionPath=Join-Path $workerRoot 'worker.version.json'
$updateScript=Join-Path $workerRoot 'FrameCut-Worker-Update.ps1'
$workerVersion='legacy'
if(Test-Path -LiteralPath $versionPath){
  try {$versionInfo=Get-Content -LiteralPath $versionPath -Raw|ConvertFrom-Json;$workerVersion=[string]$versionInfo.version}catch{}
}
$autoUpdate = -not ($config.PSObject.Properties.Name -contains 'AutoUpdate' -and $config.AutoUpdate -eq $false)
$updateCheckSeconds = if($config.UpdateCheckSeconds){[Math]::Max(60,[int]$config.UpdateCheckSeconds)}else{300}
$script:lastUpdateCheck=[datetime]::MinValue

# Every executable helper is bundled in this repository. Per-worker overrides are still
# supported for a custom Pinokio or ComfyUI layout, but a fresh clone has portable defaults.
$renderClient = if ($config.RenderClientPath) { $config.RenderClientPath } else { Join-Path $workerRoot 'adapters\minimax-h3\render_shot.py' }
$imageClient = if ($config.ImageClientPath) { $config.ImageClientPath } else { Join-Path $workerRoot 'adapters\comfyui\zimage.py' }
$captionClient = if ($config.CaptionClientPath) { $config.CaptionClientPath } else { Join-Path $workerRoot 'adapters\comfyui\caption.py' }
$comfyAppPath = if ($config.ComfyAppPath) { $config.ComfyAppPath } else { Join-Path $pinokioHome 'api\comfy.git\app' }
$comfyOutputRoot = Join-Path $comfyAppPath 'output'
$comfyPythonExe = Join-Path $comfyAppPath 'env\Scripts\python.exe'
$qwenAppPath = if ($config.QwenTtsAppPath) { $config.QwenTtsAppPath } else { Join-Path $pinokioHome 'api\Qwen3-TTS-Pinokio.git\app' }
$qwenPythonExe = if ($config.QwenTtsPythonPath) { $config.QwenTtsPythonPath } else { Join-Path $qwenAppPath 'venv\Scripts\python.exe' }
$qwenClient = Join-Path $workerRoot 'framecut_qwen_tts.py'
$qwenModelSize = if ($config.QwenTtsModelSize) { [string]$config.QwenTtsModelSize } else { '0.6B' }
$qwenVoiceMode = if ($config.QwenTtsVoiceMode) { [string]$config.QwenTtsVoiceMode } else { 'custom' }
$stableAudioClient = Join-Path $workerRoot 'framecut_stable_audio.py'
$stableAudioPython = if ($config.StableAudioPythonPath) { $config.StableAudioPythonPath } else { $qwenPythonExe }
$stableAudioRef = if ($config.StableAudioRef) { [string]$config.StableAudioRef } else { '' }
$stableAudioLaunchScript = if ($config.StableAudioLaunchScript) { [string]$config.StableAudioLaunchScript } else { 'start.js' }
$stableAudioMusicUrl = if ($config.StableAudioMusicUrl) { [string]$config.StableAudioMusicUrl } else { '' }
$stableAudioSfxUrl = if ($config.StableAudioSfxUrl) { [string]$config.StableAudioSfxUrl } else { '' }
$stableAudioTimeout = if ($config.StableAudioTimeoutSeconds) { [Math]::Max(120, [int]$config.StableAudioTimeoutSeconds) } else { 1800 }
$jobWorkspaceRoot = Join-Path $runtimeRoot 'jobs'
# Working folders only contain copies, logs and intermediate render results. They are
# deliberately separate from approved keyframes and central project media, which must
# never be removed by the local worker cleanup routine.
$failedJobRetentionHours = if ($config.FailedJobRetentionHours -ne $null) { [Math]::Max(1, [int]$config.FailedJobRetentionHours) } else { 168 }
$minimumFreeDiskGb = if ($config.MinimumFreeDiskGb -ne $null) { [Math]::Max(1, [double]$config.MinimumFreeDiskGb) } else { 12 }
$script:storageWarned = $false

# Clips are delivered without sound by default; set StripAudio to false in worker.config.json
# to keep whatever the video model generated.
$stripAudio = -not ($config.PSObject.Properties.Name -contains 'StripAudio' -and $config.StripAudio -eq $false)
$h3AppPath = if ($config.H3AppPath) { $config.H3AppPath } else { Join-Path $pinokioHome 'api\minimax-h3-pinokio.git\app' }
$h3ReferenceModel = Join-Path $h3AppPath 'models\diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors'
# Auto-enable exact H3 identity conditioning when the local Ref2VA model exists.
# An explicit false remains an emergency fallback to the ordinary image-to-video path.
$useH3ReferenceConditioning = $config.PSObject.Properties.Name -contains 'UseH3ReferenceConditioning' -and $config.UseH3ReferenceConditioning -eq $true
$h3ReferenceImageSize = if ($config.H3ReferenceImageSize -in @('match','max')) { [string]$config.H3ReferenceImageSize } else { 'match' }
$ffmpegExe = if ($config.FfmpegPath -and (Test-Path -LiteralPath $config.FfmpegPath)) { $config.FfmpegPath }
  elseif ((Get-Command ffmpeg -ErrorAction SilentlyContinue)) { (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
  elseif (Test-Path -LiteralPath (Join-Path $workerRoot 'tools\ffmpeg\bin\ffmpeg.exe')) { Join-Path $workerRoot 'tools\ffmpeg\bin\ffmpeg.exe' }
  elseif (Test-Path -LiteralPath (Join-Path $workerRoot 'tools\ffmpeg.exe')) { Join-Path $workerRoot 'tools\ffmpeg.exe' }
  else {
    $pwFfmpeg = Get-ChildItem -Path (Join-Path $pinokioHome 'bin\playwright\browsers') -Filter 'ffmpeg-win64.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pwFfmpeg) { $pwFfmpeg.FullName } else { $null }
  }
$ffprobeExe = if ($config.FfprobePath -and (Test-Path -LiteralPath $config.FfprobePath)) { $config.FfprobePath }
  elseif ((Get-Command ffprobe -ErrorAction SilentlyContinue)) { (Get-Command ffprobe -ErrorAction SilentlyContinue).Source }
  elseif ($ffmpegExe) {
    $siblingProbe = Join-Path (Split-Path -Parent $ffmpegExe) 'ffprobe.exe'
    if (Test-Path -LiteralPath $siblingProbe) { $siblingProbe } else { $null }
  } else { $null }
if ($stripAudio -and -not $ffmpegExe) {
  Write-Host 'Hinweis: ffmpeg wurde nicht gefunden - Clips behalten ihre Original-Tonspur.' -ForegroundColor Yellow
  $stripAudio = $false
}

if(-not (Test-Path -LiteralPath $pterm)){Write-Host 'Pinokio/pterm wurde nicht gefunden.' -ForegroundColor Yellow;exit 1}
if(-not (Test-Path -LiteralPath $renderClient)){Write-Host 'MiniMax-H3-Client wurde nicht gefunden.' -ForegroundColor Yellow;exit 1}

Add-Type -AssemblyName System.Security

function Get-Sha256Hex([string]$Path) {
  # Get-FileHash is not guaranteed to be exported in every PowerShell host that
  # Pinokio starts. Use the framework implementation so reference integrity
  # checks work identically on Windows PowerShell 5.1 and PowerShell 7.
  $stream = [IO.File]::OpenRead($Path)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FrameCutPower {
  [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ReasonContext { public uint Version; public uint Flags; [MarshalAs(UnmanagedType.LPWStr)] public string Reason; }
  private static IntPtr request = IntPtr.Zero;
  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr PowerCreateRequest(ref ReasonContext context);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool PowerSetRequest(IntPtr handle, int requestType);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool PowerClearRequest(IntPtr handle, int requestType);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);

  // SystemRequired=1 and ExecutionRequired=3 are process-bound requests understood by
  // Modern Standby. They remain in force while a long ComfyUI/MiniMax child process runs.
  public static void AcquirePowerRequest() {
    if (request != IntPtr.Zero) return;
    var context = new ReasonContext { Version = 0, Flags = 1, Reason = "FrameCut local render worker is processing queued media" };
    request = PowerCreateRequest(ref context);
    if (request != IntPtr.Zero && request.ToInt64() != -1) { PowerSetRequest(request, 1); PowerSetRequest(request, 3); }
    else request = IntPtr.Zero;
  }
  public static void ReleasePowerRequest() {
    if (request == IntPtr.Zero) return;
    PowerClearRequest(request, 3); PowerClearRequest(request, 1); CloseHandle(request); request = IntPtr.Zero;
  }
}
'@

function Set-Awake([bool]$Enabled) {
  if ($Enabled) {
    [FrameCutPower]::AcquirePowerRequest()
    # Away mode is a second independent request for Modern Standby hosts.
    [void][FrameCutPower]::SetThreadExecutionState([Convert]::ToUInt32('80000041',16))
  } else {
    [FrameCutPower]::ReleasePowerRequest()
    [void][FrameCutPower]::SetThreadExecutionState([Convert]::ToUInt32('80000000',16))
  }
}
function Get-FreeDiskGb([string]$Path) {
  try {
    $fullPath = [IO.Path]::GetFullPath($Path)
    $driveRoot = [IO.Path]::GetPathRoot($fullPath)
    if (-not $driveRoot) { return $null }
    $disk = Get-CimInstance Win32_LogicalDisk -Filter ("DeviceID='{0}'" -f $driveRoot.TrimEnd('\\')) -ErrorAction Stop
    if ($disk -and $null -ne $disk.FreeSpace) { return [Math]::Round(([double]$disk.FreeSpace / 1GB), 2) }
  } catch {
    Write-Host ("Warnung: Freien Worker-Speicher konnte nicht ermittelt werden: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  }
  return $null
}
function Get-JobWorkspace($Job) {
  switch ([string]$Job.kind) {
    'caption_asset' { return Join-Path $jobWorkspaceRoot ("caption-{0}" -f $Job.id) }
    'audio_preview' { return Join-Path $jobWorkspaceRoot ("audio-preview-{0}" -f $Job.id) }
    'audio_cue' { return Join-Path $jobWorkspaceRoot ("audio-cue-{0}" -f $Job.id) }
    'audio_mix' { return Join-Path $jobWorkspaceRoot ("audio-mix-{0}" -f $Job.id) }
    'minimax_h3' { return Join-Path $jobWorkspaceRoot ([string]$Job.id) }
    default { return $null }
  }
}
function Remove-ConfirmedJobWorkspace($Job) {
  $workspace = Get-JobWorkspace $Job
  if (-not $workspace -or -not (Test-Path -LiteralPath $workspace)) { return }
  try {
    # This function is reached only after the server accepted the result endpoint or
    # completed a report call. Never call it from an error path: failed workspaces are
    # retained for diagnosis and the scheduled expiry sweep below.
    Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction Stop
    Write-Host ("Lokaler Arbeitsordner nach bestätigtem Upload entfernt: {0}" -f (Split-Path $workspace -Leaf)) -ForegroundColor DarkGray
  } catch {
    Write-Host ("Warnung: Arbeitsordner konnte nicht bereinigt werden: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  }
}
function Invoke-ExpiredWorkspaceCleanup {
  New-Item -ItemType Directory -Force -Path $jobWorkspaceRoot | Out-Null
  $cutoff = (Get-Date).AddHours(-$failedJobRetentionHours)
  $removed = 0
  foreach ($workspace in @(Get-ChildItem -LiteralPath $jobWorkspaceRoot -Directory -ErrorAction SilentlyContinue)) {
    if ($workspace.LastWriteTime -ge $cutoff) { continue }
    try {
      Remove-Item -LiteralPath $workspace.FullName -Recurse -Force -ErrorAction Stop
      $removed++
    } catch {
      Write-Host ("Warnung: Alter Arbeitsordner konnte nicht bereinigt werden ({0}): {1}" -f $workspace.Name,$_.Exception.Message) -ForegroundColor Yellow
    }
  }
  if ($removed -gt 0) { Write-Host ("Storage-Cleanup: {0} abgelaufene Fehler-Arbeitsordner entfernt." -f $removed) -ForegroundColor DarkGray }
}
function Test-WorkerStorageAvailable {
  $freeGb = Get-FreeDiskGb $runtimeRoot
  if ($null -eq $freeGb -or $freeGb -ge $minimumFreeDiskGb) {
    $script:storageWarned = $false
    return $true
  }
  if (-not $script:storageWarned) {
    Write-Host ("WORKER PAUSIERT: Nur noch {0:N2} GB frei; mindestens {1:N2} GB sind konfiguriert. Es werden keine neuen Jobs beansprucht, bis Speicher freigegeben wurde." -f $freeGb,$minimumFreeDiskGb) -ForegroundColor Red
    $script:storageWarned = $true
  }
  return $false
}
function Get-ClipDurationSeconds([string]$Path) {
  if(-not $ffprobeExe -or -not (Test-Path -LiteralPath $ffprobeExe)){return $null}
  try {
    $raw=(& $ffprobeExe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $Path 2>$null | Out-String).Trim()
    $duration=0.0
    if([double]::TryParse($raw,[Globalization.NumberStyles]::Float,[Globalization.CultureInfo]::InvariantCulture,[ref]$duration) -and $duration -gt 0){return $duration}
  } catch { Write-Host ("Warnung: Clipdauer nicht lesbar: {0}" -f $_.Exception.Message) -ForegroundColor Yellow }
  return $null
}
function Read-WorkerToken {
  $hex = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  $bytes = New-Object byte[] ($hex.Length/2)
  for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}
  $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::Unicode.GetString($plain)
}
function Headers { return @{'x-framecut-worker'=(Read-WorkerToken);'x-framecut-worker-id'=$config.WorkerId} }
function Get-RuntimeInventory {
  $modelRoot=Join-Path $h3AppPath 'models'
  return [ordered]@{
    pinokio=Test-Path -LiteralPath $pterm
    h3App=Test-Path -LiteralPath $h3AppPath
    h3RefModel=Test-Path -LiteralPath (Join-Path $modelRoot 'diffusion_models\minimax_h3_ref2va_pruned_int8_convrot.safetensors')
    h3FlModel=Test-Path -LiteralPath (Join-Path $modelRoot 'diffusion_models\minimax_h3_fl2va_pruned_int8_convrot.safetensors')
    h3TextEncoder=Test-Path -LiteralPath (Join-Path $modelRoot 'text_encoders\qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors')
    h3VideoVae=Test-Path -LiteralPath (Join-Path $modelRoot 'vae\minimax_h3_video_vae_fp16.safetensors')
    h3AudioVae=Test-Path -LiteralPath (Join-Path $modelRoot 'vae\minimax_h3_audio_vae_fp32.safetensors')
    h3TurboLora=Test-Path -LiteralPath (Join-Path $modelRoot 'loras\minimax_h3_turbo_v4_step600_ema.safetensors')
    qwenTts=Test-Path -LiteralPath $qwenPythonExe
    stableAudio=[bool]($stableAudioRef -or $stableAudioMusicUrl -or $stableAudioSfxUrl)
    ffmpeg=[bool]$ffmpegExe
  }
}
function Report-WorkerVersion {
  try {
    $body=@{version=$workerVersion;autoUpdate=$autoUpdate;runtime=(Get-RuntimeInventory)}|ConvertTo-Json -Depth 5 -Compress
    return Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/version" -Headers (Headers) -ContentType 'application/json' -Body $body
  } catch { Write-Host ("Worker-Version konnte nicht gemeldet werden: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow }
}
function Get-PendingWorkerUpdate {
  if(-not $autoUpdate -or -not (Test-Path -LiteralPath $updateScript)){return $null}
  if(((Get-Date)-$script:lastUpdateCheck).TotalSeconds -lt $updateCheckSeconds){return $null}
  $script:lastUpdateCheck=Get-Date
  try {
    # Dashboard requests are consumed only while idle. The server clears a request
    # when the restarted worker reports the requested version back.
    $versionReport=Report-WorkerVersion
    $manifest=Invoke-RestMethod -Method Get -Uri "$($config.ServerUrl)/api/worker/installer/manifest" -TimeoutSec 15
    $requested=[string]$versionReport.updateRequestedVersion
    if($manifest.version -and [string]$manifest.version -ne $workerVersion -and $manifest.downloadUrl -and $manifest.sha256){
      if($requested -and $requested -ne [string]$manifest.version){Write-Host ("Vorgemerktes Update {0} ist nicht mehr aktuell; installiere {1}." -f $requested,$manifest.version) -ForegroundColor DarkYellow}
      return $manifest
    }
  } catch { Write-Host ("Worker-Updateprüfung übersprungen: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow }
  return $null
}
function Start-WorkerUpdate($Manifest) {
  $args='-NoProfile -ExecutionPolicy Bypass -File "'+$updateScript+'" -ServerUrl "'+$config.ServerUrl+'" -WorkerRoot "'+$workerRoot+'" -ParentPid '+$PID
  Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList $args -WorkingDirectory $workerRoot -WindowStyle Hidden
  Write-Host ("Worker-Update {0} wird im Leerlauf installiert; Neustart folgt automatisch." -f [string]$Manifest.version) -ForegroundColor Cyan
}
function Report-Job([int]$Id,[string]$Action,[string]$Detail,[string]$OutputPath='') {
  $payload=@{detail=$Detail}; if($OutputPath){$payload.outputPath=$OutputPath}
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$Id/$Action" -Headers (Headers) -ContentType 'application/json' -Body ($payload|ConvertTo-Json) | Out-Null
}
function Get-PinokioStatus([string]$Ref) {
  if (-not $Ref) { return $null }
  try { return (& $pterm status $Ref --probe | ConvertFrom-Json) } catch { return $null }
}
function Get-H3Status { return Get-PinokioStatus $config.H3Ref }
function Invoke-PtermBounded([string]$Action,[int]$TimeoutSeconds=90,[string]$Ref=$config.H3Ref,[string[]]$ExtraArgs=@()) {
  # Serialize trailing pterm arguments. Start-Job otherwise flattens an array on
  # some Windows PowerShell versions and loses --default/start.js.
  # ConvertTo-Json emits no value for an empty PowerShell array.  Always pass a
  # JSON array so stop calls do not fail before pterm is invoked.
  $extraJson = if (@($ExtraArgs).Count) { @($ExtraArgs) | ConvertTo-Json -Compress } else { '[]' }
  $command=Start-Job -ScriptBlock { param($ptermPath,$verb,$ref,$extraJson) $extra=@(ConvertFrom-Json -InputObject $extraJson); & $ptermPath $verb $ref @extra 2>&1 } -ArgumentList $pterm,$Action,$Ref,$extraJson
  $finished=Wait-Job -Job $command -Timeout $TimeoutSeconds
  if(-not $finished){
    Stop-Job -Job $command -ErrorAction SilentlyContinue
    Remove-Job -Job $command -Force -ErrorAction SilentlyContinue
    return [pscustomobject]@{TimedOut=$true;Output=''}
  }
  $output=(Receive-Job -Job $command 2>&1|Out-String).Trim()
  Remove-Job -Job $command -Force -ErrorAction SilentlyContinue
  return [pscustomobject]@{TimedOut=$false;Output=$output}
}
function Wait-PinokioReady([string]$Ref,[int]$TimeoutSeconds=600) {
  for($elapsed=0;$elapsed -lt $TimeoutSeconds;$elapsed+=5){
    $status=Get-PinokioStatus $Ref
    if($status -and $status.ready){return $true}
    Start-Sleep -Seconds 5
  }
  return $false
}
function Wait-H3Ready([int]$TimeoutSeconds=600) { return Wait-PinokioReady $config.H3Ref $TimeoutSeconds }
function Reset-H3 {
  Write-Host 'MiniMax H3 wird kontrolliert zurueckgesetzt ...' -ForegroundColor Yellow
  $stop=Invoke-PtermBounded 'stop' 90
  if($stop.TimedOut){Write-Host 'pterm stop hat das Timeout erreicht; starte trotzdem einen einzigen frischen H3-Versuch.' -ForegroundColor Yellow}
  Start-Sleep -Seconds 8
}
function Ensure-H3 {
  # Stable Audio owns the same local GPU. Stop it before H3 starts rather than
  # letting two heavyweight models contend for a few GB of VRAM.
  $stable=Get-PinokioStatus $stableAudioRef
  if($stable -and $stable.running){
    Write-Host 'Stable Audio wird für den nächsten Video-Job freigegeben ...' -ForegroundColor DarkGray
    [void](Invoke-PtermBounded 'stop' 90 $stableAudioRef)
    Start-Sleep -Seconds 4
  }
  $status=Get-H3Status
  if($status -and $status.ready){return}

  # If Pinokio already owns a startup, wait for that single attempt. Calling `pterm run`
  # repeatedly here interrupts the loading process and caused the former endless loop.
  $state=if($status){[string]$status.state}else{''}
  if($status -and (($status.running -eq $true) -or $state -eq 'starting')){
    Write-Host 'MiniMax H3 startet bereits; warte ohne zweiten Startversuch ...' -ForegroundColor Cyan
    if(Wait-H3Ready 600){return}
    Reset-H3
  }

  for($attempt=1;$attempt -le 2;$attempt++){
    Write-Host ("MiniMax H3 wird ueber Pinokio gestartet (Versuch {0}/2) ..." -f $attempt) -ForegroundColor Cyan
    $start=Invoke-PtermBounded 'run' 90
    if($start.TimedOut){
      Write-Host 'pterm run bleibt geöffnet; prüfe den tatsächlichen H3-Status weiter ...' -ForegroundColor Yellow
      $afterStart=Get-H3Status
      if($afterStart -and $afterStart.ready){return}
      $afterState=if($afterStart){[string]$afterStart.state}else{''}
      if($afterStart -and (($afterStart.running -eq $true) -or $afterState -eq 'starting')){
        if(Wait-H3Ready 600){return}
      }
      if($attempt -lt 2){Reset-H3;continue}
      break
    }
    if(Wait-H3Ready 600){return}
    Write-Host 'MiniMax H3 wurde nicht rechtzeitig bereit.' -ForegroundColor Yellow
    if($attempt -lt 2){Reset-H3}
  }
  throw 'MiniMax H3 konnte nach einem kontrollierten Reset nicht gestartet werden.'
}
function Ensure-StableAudio {
  if(-not $stableAudioRef){throw 'Stable Audio ist nicht konfiguriert. Setze StableAudioRef im Worker-Setup.'}
  # Render jobs are serial, nevertheless H3 can remain resident after the last clip.
  # Explicitly stop it before starting Stable Audio to make the GPU hand-over reliable.
  $h3=Get-H3Status
  if($h3 -and $h3.running){
    Write-Host 'MiniMax H3 wird für die Audio-Spur freigegeben ...' -ForegroundColor DarkGray
    [void](Invoke-PtermBounded 'stop' 90 $config.H3Ref)
    Start-Sleep -Seconds 5
  }
  $status=Get-PinokioStatus $stableAudioRef
  if($status -and $status.ready -and $status.ready_url){return [string]$status.ready_url}
  if($status -and $status.running){
    Write-Host 'Stable Audio startet bereits; warte auf die lokale API ...' -ForegroundColor Cyan
    if(Wait-PinokioReady $stableAudioRef 900){return [string](Get-PinokioStatus $stableAudioRef).ready_url}
    throw 'Stable Audio wurde nicht rechtzeitig bereit.'
  }
  Write-Host 'Stable Audio 3 wird über Pinokio gestartet ...' -ForegroundColor Cyan
  # `pterm run` may intentionally remain attached while the launched web app is
  # healthy.  Treat the probed API state as authoritative instead of turning a
  # still-open launcher process into a false failed audio job.
  $start=Invoke-PtermBounded 'run' 45 $stableAudioRef @('--default',$stableAudioLaunchScript)
  if($start.TimedOut){
    if(Wait-PinokioReady $stableAudioRef 90){return [string](Get-PinokioStatus $stableAudioRef).ready_url}
    throw 'Pinokio konnte Stable Audio nicht rechtzeitig starten.'
  }
  if(-not (Wait-PinokioReady $stableAudioRef 900)){throw 'Stable Audio wurde nicht rechtzeitig bereit.'}
  $ready=[string](Get-PinokioStatus $stableAudioRef).ready_url
  if(-not $ready){throw 'Stable Audio meldet keine lokale API-URL.'}
  return $ready
}
function Free-Models([string]$Url) {
  try { Invoke-RestMethod -Method Post -Uri "$Url/free" -ContentType 'application/json' -Body '{"unload_models":true,"free_memory":true}' | Out-Null } catch {}
}
function Ensure-Comfy {
  try { Invoke-RestMethod -Uri "$($config.ComfyUrl)/object_info" -TimeoutSec 4 | Out-Null; return } catch {}
  Write-Host 'ComfyUI Bild-Worker wird isoliert auf Port 8190 gestartet ...' -ForegroundColor Cyan
  $comfyPython=Join-Path $comfyAppPath 'env\Scripts\python.exe'
  if(-not (Test-Path -LiteralPath $comfyPython)){throw 'Die lokale ComfyUI-Python-Umgebung wurde nicht gefunden.'}
  $process=Start-Process -FilePath $comfyPython -ArgumentList @('main.py','--port','8190','--lowvram') -WorkingDirectory $comfyAppPath -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath (Join-Path $runtimeRoot 'comfy-image.pid') -Value $process.Id -Encoding ascii
  for($attempt=0;$attempt -lt 60;$attempt++){
    Start-Sleep -Seconds 5
    try { Invoke-RestMethod -Uri "$($config.ComfyUrl)/object_info" -TimeoutSec 4 | Out-Null; return } catch {}
  }
  throw 'ComfyUI Bild-Worker wurde nicht innerhalb von fuenf Minuten bereit.'
}
function Stop-OwnedComfy {
  $ownedPidPath=Join-Path $runtimeRoot 'comfy-image.pid'
  if(-not (Test-Path -LiteralPath $ownedPidPath)){return}
  $ownedPid=[int](Get-Content -LiteralPath $ownedPidPath -Raw)
  $process=Get-CimInstance Win32_Process -Filter "ProcessId=$ownedPid" -ErrorAction SilentlyContinue
  if($process -and $process.ExecutablePath -like '*Pinokio\api\comfy.git\app\env\Scripts\python.exe'){
    Stop-Process -Id $ownedPid -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $ownedPidPath -Force -ErrorAction SilentlyContinue
}
function Invoke-ZImage([string]$Prompt,[string]$Prefix,[int]$Seed,[int]$Steps=12,[string]$NegativePrompt='',[int]$Width=768,[int]$Height=448,[double]$Cfg=1.0) {
  Ensure-Comfy
  $env:COMFY_URL=$config.ComfyUrl
  $imageTimeout=if($config.ImageTimeoutSeconds){[Math]::Max(120,[int]$config.ImageTimeoutSeconds)}else{900}
  $baseNegative='contact sheet, storyboard grid, collage, split screen, multiple panels, model sheet, turnaround sheet, white background, text, caption, watermark, logo, malformed anatomy, duplicate people, extra limbs, flat lighting, open door on a moving vehicle, laptop outside a vehicle, physically impossible vehicle, floating objects'
  $effectiveNegative=if($NegativePrompt){"$baseNegative, $NegativePrompt"}else{$baseNegative}
  try { Invoke-BoundedPython @($imageClient,$Prompt,'--cfg',$Cfg.ToString([Globalization.CultureInfo]::InvariantCulture),'--negativ',$effectiveNegative,'--breite',[string]$Width,'--hoehe',[string]$Height,'--schritte',[string]$Steps,'--seed',[string]$Seed,'--name',$Prefix) $imageTimeout 'ComfyUI Z-Image' } finally { Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue }
  $folder=Split-Path $Prefix -Parent
  $leaf=Split-Path $Prefix -Leaf
  $result=Get-ChildItem -LiteralPath (Join-Path $comfyOutputRoot $folder) -Filter "$leaf*.png"|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw "ComfyUI meldete Erfolg, aber $leaf wurde nicht gefunden."}
  return $result.FullName
}
function Test-KeyframeHasWhiteStudioBackground([string]$Path) {
  # A reference-card/studio frame is especially destructive in image-to-video:
  # H3 faithfully animates its white paper background for the opening seconds.
  # Reject only near-solid white borders; bright skies and normal daylight scenes
  # still contain enough colour/contrast to pass.
  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
    $bitmap = [Drawing.Bitmap]::new($Path)
    try {
      $samples = 0; $nearWhite = 0
      $stride = [Math]::Max(1,[int]($bitmap.Width / 80))
      for ($x=0; $x -lt $bitmap.Width; $x += $stride) {
        foreach ($y in @(0, [Math]::Max(0,$bitmap.Height-1))) {
          $pixel=$bitmap.GetPixel($x,$y); $samples++
          if($pixel.R -ge 242 -and $pixel.G -ge 242 -and $pixel.B -ge 242){$nearWhite++}
        }
      }
      $strideY = [Math]::Max(1,[int]($bitmap.Height / 60))
      for ($y=0; $y -lt $bitmap.Height; $y += $strideY) {
        foreach ($x in @(0, [Math]::Max(0,$bitmap.Width-1))) {
          $pixel=$bitmap.GetPixel($x,$y); $samples++
          if($pixel.R -ge 242 -and $pixel.G -ge 242 -and $pixel.B -ge 242){$nearWhite++}
        }
      }
      if($samples -gt 0 -and (($nearWhite / $samples) -ge 0.76)){return $true}
      # Reject a tall, near-white side panel too. This is the typical signature
      # of a character turnaround/reference card embedded in an otherwise valid
      # scene; bright skies and lamps do not fill almost the entire height.
      $columns=96;$rows=72;$whitePanelColumns=0
      for($column=0;$column -lt $columns;$column++){
        $x=[Math]::Min($bitmap.Width-1,[int](($column+0.5)*$bitmap.Width/$columns))
        $whiteRows=0
        for($row=0;$row -lt $rows;$row++){
          $y=[Math]::Min($bitmap.Height-1,[int](($row+0.5)*$bitmap.Height/$rows))
          $pixel=$bitmap.GetPixel($x,$y)
          if($pixel.R -ge 242 -and $pixel.G -ge 242 -and $pixel.B -ge 242){$whiteRows++}
        }
        if(($whiteRows/$rows) -ge 0.68){$whitePanelColumns++}
      }
      # The portrayed person interrupts a white card, so a contiguous strip is
      # not enough; count its near-white full-height columns across the frame.
      return $whitePanelColumns -ge 18
    } finally { $bitmap.Dispose() }
  } catch { return $false }
}
function Clean-GuideText([string]$Text) {
  if (-not $Text) { return '' }
  $t = $Text -replace '(?i)\b(the|this) (image|picture|photo|illustration|drawing|render) (depicts|shows|features|presents|portrays|displays)\s*', ''
  $t = $t -replace '(?i)\b(isolated|cut[- ]?out|on (a )?(plain |pure |clean |solid )?white (background|backdrop)|white (background|backdrop|studio|paper)|character sheet|model sheet|turnaround( sheet)?|reference (sheet|image|card|photo)|contact sheet|studio backdrop|no background|blank background)\b', ''
  $t = $t -replace '(?i)\bvector[- ]?(like )?(rendering|aesthetic|art|style)?\b', 'crisp line art'
  $t = $t -replace '(?i)--(ar|v)\s+\S+', ''
  $t = $t -replace '\s+([,.;])', '$1' -replace '([,.;])\s*[,.;]+', '$1' -replace '\s{2,}', ' '
  return $t.Trim(' ', ',', ';')
}
function Get-SharedSceneGuidePrompt($Contract,$Shot) {
  $locations=@();$subjects=@()
  foreach($reference in @($Contract.references)){
    if([string]$reference.role -eq 'style'){continue}
    # English appearance tags (generated server-side) keep characters on-model far better than German prose.
    $detail=if([string]$reference.visual_tags){[string]$reference.visual_tags}else{Clean-GuideText ((@([string]$reference.summary,[string]$reference.visual_notes)|Where-Object {$_}|ForEach-Object {$_.Trim()}) -join ' ')}
    if($detail.Length -gt 320){$detail=$detail.Substring(0,320)}
    $line=("{0}: {1}" -f [string]$reference.name,$detail)
    if([string]$reference.kind -eq 'location'){$locations+=$line}else{$subjects+=$line}
  }
  $style=Clean-GuideText ([string]$Contract.style)
  if(-not $style){$style='coherent cinematic animation with one consistent visual medium and palette'}
  $locationText=if($locations.Count){$locations -join '; '}else{'the place described in the scene action'}
  $subjectText=if($subjects.Count){$subjects -join '; '}else{'only the setting and props named in the scene action'}
  $guide=@"
A single cinematic film frame taken inside one real, lived-in location, with depth from foreground to far background.
Scene action: $(if([string]$Shot.prompt_en){[string]$Shot.prompt_en}else{(Clean-GuideText ([string]$Shot.prompt))+' Camera: '+[string]$Shot.camera})
Location: $locationText. The environment is fully rendered in every corner of the frame: floor, walls, ceiling or sky, furniture, props, atmosphere and lighting continue edge to edge behind and around everyone.
Acting in this frame, each appearing exactly once and interacting inside the location: $subjectText
Visual style: $style, applied equally to the characters and the richly detailed surrounding environment.
"@
  return $guide.Replace("`r",' ').Replace("`n",' ')
}
function Invoke-BoundedPython([string[]]$Arguments,[int]$TimeoutSeconds,[string]$Operation) {
  $pythonExe = if ($config.PythonPath -and (Test-Path -LiteralPath $config.PythonPath)) {
    $config.PythonPath
  } elseif (Test-Path -LiteralPath (Join-Path $pinokioHome 'bin\miniforge\python.exe')) {
    Join-Path $pinokioHome 'bin\miniforge\python.exe'
  } elseif (Test-Path -LiteralPath (Join-Path $pinokioHome 'bin\py\env\Scripts\python.exe')) {
    Join-Path $pinokioHome 'bin\py\env\Scripts\python.exe'
  } else {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps\\python\.exe' -and (Test-Path -LiteralPath $cmd.Source)) {
      $cmd.Source
    } else {
      throw 'Python wurde weder in Pinokio noch im Systempfad gefunden.'
    }
  }
  $task=Start-Job -ScriptBlock {
    param($exe,$childArgs)
    & $exe @childArgs
    [pscustomobject]@{FrameCutExitCode=[int]$LASTEXITCODE}
  } -ArgumentList $pythonExe,(,$Arguments)
  try {
    if(-not (Wait-Job -Job $task -Timeout $TimeoutSeconds)) {
      Stop-Job -Job $task -ErrorAction SilentlyContinue
      throw "$Operation hat das Zeitlimit von $TimeoutSeconds Sekunden überschritten und wurde beendet."
    }
    $items=@(Receive-Job -Job $task)
    $result=@($items|Where-Object {$_.PSObject.Properties.Name -contains 'FrameCutExitCode'}|Select-Object -Last 1)
    $items|Where-Object {$_.PSObject.Properties.Name -notcontains 'FrameCutExitCode'}|ForEach-Object {Write-Host $_}
    if(-not $result -or $result[0].FrameCutExitCode -ne 0){throw "$Operation wurde mit Code $($result[0].FrameCutExitCode) beendet."}
  } finally {
    Remove-Job -Job $task -Force -ErrorAction SilentlyContinue
  }
}
function Get-CleanReference($Reference) {
  $cacheDir=Join-Path $runtimeRoot 'clean-references'
  New-Item -ItemType Directory -Force -Path $cacheDir|Out-Null
  $cached=Join-Path $cacheDir ("asset-{0}.png" -f [int]$Reference.id)
  if(Test-Path -LiteralPath $cached){return $cached}
  $presentation=if($Reference.kind -eq 'character'){'one single character, full-body three-quarter portrait, natural neutral pose, one person only'}elseif($Reference.kind -eq 'location'){'one single empty cinematic environment, full-bleed wide establishing frame'}else{'one single clearly recognizable object, three-quarter product view on a dark contextual background'}
  $prompt=("SINGLE FULL-BLEED REFERENCE IMAGE, never a sheet or collage. {0}. {1}. {2} {3}. Project style: {4}. Consistent proportions and identity, dark cinematic Swiss neo-cyberpunk, grounded believable materials, deep indigo shadows, restrained cyan and magenta practical light, no writing, no border." -f $presentation,$Reference.name,$Reference.summary,$Reference.visual_notes,$Reference.job_style).Replace("`r",' ').Replace("`n",' ')
  $generated=Invoke-ZImage $prompt ("framecut-v2/clean-ref-{0}" -f [int]$Reference.id) (200000+[int]$Reference.id) 12
  Copy-Item -LiteralPath $generated -Destination $cached -Force
  return $cached
}
function Process-ImageJob($payload) {
  $job=$payload.job;$asset=$payload.asset
  Write-Host ("Bildjob {0}: {1} - {2}" -f $job.id,$asset.kind,$asset.name) -ForegroundColor Green
  Free-Models $config.H3Url
  Ensure-Comfy
  $prefix=("framecut/job-{0}" -f $job.id)
  $photoSteps=if($job.photo_steps){[int]$job.photo_steps}else{8}
  $negativePrompt=if($asset.kind -eq 'character'){
    'text, caption, watermark, malformed anatomy, duplicate person, twin, clone, multiple people, contact sheet, character turnaround, white background, flat lighting'
  }else{
    'person, people, human, character, face, portrait, body, hands, crowd, text, caption, watermark, white background, flat lighting'
  }
  $env:COMFY_URL=$config.ComfyUrl
  $imageTimeout=if($config.ImageTimeoutSeconds){[Math]::Max(120,[int]$config.ImageTimeoutSeconds)}else{900}
  $identitySeed=if($asset.identity_seed){[int]$asset.identity_seed}else{100000+[int]$asset.id}
  try { Invoke-BoundedPython @($imageClient,$payload.prompt,'--negativ',$negativePrompt,'--breite','768','--hoehe','432','--schritte',[string]$photoSteps,'--seed',[string]$identitySeed,'--name',$prefix) $imageTimeout 'ComfyUI Referenzbild' } finally { Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue }
  $result=Get-ChildItem -LiteralPath (Join-Path $comfyOutputRoot 'framecut') -Filter ("job-{0}*.png" -f $job.id)|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw 'ComfyUI meldete Erfolg, aber das Vorschaubild wurde nicht gefunden.'}
  $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes($result.FullName))
  $body=@{data="data:image/png;base64,$encoded"}|ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/image" -Headers (Headers) -ContentType 'application/json' -Body $body | Out-Null
  # The asset has been persisted centrally. This ComfyUI output is only an upload copy.
  Remove-Item -LiteralPath $result.FullName -Force -ErrorAction SilentlyContinue
  Write-Host ("Referenz online gespeichert: {0}" -f $asset.name) -ForegroundColor Green
}
function Process-CaptionJob($payload) {
  $job=$payload.job;$asset=$payload.asset
  Write-Host ("Beschreibungsjob {0}: {1}" -f $job.id,$asset.name) -ForegroundColor Green
  if(-not (Test-Path -LiteralPath $captionClient)){throw 'Das Caption-Skript wurde nicht gefunden (comfy-tools\caption.py).'}
  if(-not (Test-Path -LiteralPath $comfyPythonExe)){throw 'Die lokale ComfyUI-Python-Umgebung (mit GPU/transformers) wurde nicht gefunden.'}
  $jobRoot=Join-Path $runtimeRoot ("jobs\caption-{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $jobRoot|Out-Null
  $localImage=Join-Path $jobRoot 'source.jpg'
  Invoke-WebRequest -Uri ($config.ServerUrl+$payload.downloadUrl) -Headers (Headers) -OutFile $localImage
  Free-Models $config.ComfyUrl
  Free-Models $config.H3Url
  # Do not invoke Python directly: Windows PowerShell 5.1 turns a harmless stderr warning into
  # a terminating ErrorRecord when $ErrorActionPreference='Stop'.  Keeping both streams in
  # files lets Qwen emit non-fatal HuggingFace notices without discarding the actual caption.
  $stdoutFile=Join-Path $jobRoot 'caption-stdout.log'
  $stderrFile=Join-Path $jobRoot 'caption-stderr.log'
  # Start-Process re-joins an argument array without preserving Windows paths containing
  # spaces. Pass a deliberately quoted command line so both the script and uploaded image
  # remain exactly one Python argument each.
  $captionArgs="`"$captionClient`" `"$localImage`""
  $captionProcess=Start-Process -FilePath $comfyPythonExe -ArgumentList $captionArgs -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -NoNewWindow -PassThru
  $captionTimeout=if($config.CaptionTimeoutSeconds){[Math]::Max(120,[int]$config.CaptionTimeoutSeconds)}else{1800}
  if(-not $captionProcess.WaitForExit($captionTimeout*1000)){
    Stop-Process -Id $captionProcess.Id -Force -ErrorAction SilentlyContinue
    throw "Beschreibung hat das Zeitlimit von $captionTimeout Sekunden überschritten."
  }
  $caption=if(Test-Path -LiteralPath $stdoutFile){(Get-Content -LiteralPath $stdoutFile -Raw).Trim()}else{''}
  $exitCode=$captionProcess.ExitCode
  $stderrText=if(Test-Path -LiteralPath $stderrFile){(Get-Content -LiteralPath $stderrFile -Raw).Trim()}else{''}
  # Some Windows/Python launcher combinations leave ExitCode null after redirected output even
  # though the child completed and produced a valid caption. The caption itself is the useful
  # success signal; a real Python error yields no caption and remains visible in stderr.
  if(-not $caption){throw "Die KI hat keine Beschreibung zurueckgegeben (Code $exitCode). $stderrText"}
  $body=@{text=$caption}|ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/caption" -Headers (Headers) -ContentType 'application/json' -Body $body | Out-Null
  Write-Host ("Beschreibung gespeichert: {0}" -f $asset.name) -ForegroundColor Green
}
function Invoke-QwenSpeech([array]$SpeechJobs,[string]$JobRoot) {
  try {
    if(-not (Test-Path -LiteralPath $qwenClient)){throw 'FrameCut Qwen-TTS-Adapter fehlt.'}
    if(-not (Test-Path -LiteralPath $qwenAppPath)){throw "Qwen3-TTS ist nicht installiert: $qwenAppPath"}
    if(-not (Test-Path -LiteralPath $qwenPythonExe)){throw "Qwen3-TTS Python-Umgebung fehlt: $qwenPythonExe"}
    $specPath=Join-Path $JobRoot 'speech-jobs.json'
    # ConvertTo-Json writes a single PowerShell object as `{...}`, but the Python
    # adapter intentionally accepts a list, even for one cue.  InputObject preserves
    # the array shape and avoids a silent scalar job specification.
    ConvertTo-Json -InputObject @($SpeechJobs) -Depth 8 | Set-Content -LiteralPath $specPath -Encoding utf8
    $stdoutPath=Join-Path $JobRoot 'qwen-stdout.log';$stderrPath=Join-Path $JobRoot 'qwen-stderr.log'
    $argLine="`"$qwenClient`" --qwen-app `"$qwenAppPath`" --jobs `"$specPath`" --model-size $qwenModelSize --voice-mode $qwenVoiceMode"
    Write-Host ("Qwen3-TTS erzeugt {0} Stimme(n) ..." -f $SpeechJobs.Count) -ForegroundColor Cyan
    $proc=Start-Process -FilePath $qwenPythonExe -ArgumentList $argLine -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -NoNewWindow -PassThru
    if($null -eq $proc){throw 'Qwen3-TTS-Prozess konnte nicht gestartet werden.'}
    $timeout=if($config.AudioTimeoutSeconds){[Math]::Max(600,[int]$config.AudioTimeoutSeconds)}else{7200}
    if(-not $proc.WaitForExit($timeout*1000)){Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue;throw "Qwen3-TTS hat das Zeitlimit von $timeout Sekunden überschritten."}
    $stdout=if(Test-Path $stdoutPath){(Get-Content $stdoutPath -Raw).Trim()}else{''};$stderr=if(Test-Path $stderrPath){(Get-Content $stderrPath -Raw).Trim()}else{''}
    $jsonLine=($stdout -split "`r?`n"|Where-Object {$_ -match '^\{.*\}$'}|Select-Object -Last 1)
    if(-not $jsonLine){throw "Qwen3-TTS lieferte kein Ergebnis. $stdout $stderr"}
    # Windows can clear Process.ExitCode for a just-finished redirected child even
    # though its JSON result and WAV are already present.  A valid structured result
    # is the authoritative success signal; only a concrete non-zero code without it
    # should fail the cue.
    $exitCode=$null; try { $exitCode=$proc.ExitCode } catch {}
    if($null -ne $exitCode -and [int]$exitCode -ne 0){throw "Qwen3-TTS fehlgeschlagen (Code $exitCode). $stderr"}
    return $jsonLine|ConvertFrom-Json
  } catch {
    $detail = if ($_ -and $_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { [string]$_ }
    throw "Qwen3-TTS Worker-Wrapper: $detail"
  }
}
function Invoke-StableAudioCue($Cue,[string]$JobRoot) {
  if (-not (Test-Path -LiteralPath $stableAudioClient)) { throw 'FrameCut Stable-Audio-Adapter fehlt.' }
  if (-not (Test-Path -LiteralPath $stableAudioPython)) { throw "Stable-Audio Python-Umgebung fehlt: $stableAudioPython" }
  $baseUrl = if ($Cue.kind -eq 'music') { $stableAudioMusicUrl } else { $stableAudioSfxUrl }
  if (-not $baseUrl) {
    $baseUrl = Ensure-StableAudio
  }
  $spec = Join-Path $JobRoot 'stable-audio-cue.json'
  $output = Join-Path $JobRoot 'generated-audio.wav'
  # Episode quality settings reach this function through the calling job (empty = 8 steps, cfg 1.0).
  $audioSteps=if($payload.job.audio_steps){[int]$payload.job.audio_steps}else{8}
  $audioCfg=if($payload.job.audio_cfg){[double]$payload.job.audio_cfg}else{1.0}
  @{prompt=[string]$Cue.prompt;duration_seconds=[Math]::Max(1,[Math]::Ceiling(([double]$Cue.target_duration_ms)/1000));output=$output;steps=$audioSteps;cfg=$audioCfg}|ConvertTo-Json -Compress|Set-Content -LiteralPath $spec -Encoding utf8
  $stdout = Join-Path $JobRoot 'stable-audio-stdout.log'; $stderr = Join-Path $JobRoot 'stable-audio-stderr.log'
  $argLine="`"$stableAudioClient`" --base-url `"$baseUrl`" --spec `"$spec`""
  Write-Host ("Stable Audio 3 erzeugt {0} ({1}s) ..." -f $Cue.kind,([Math]::Ceiling(([double]$Cue.target_duration_ms)/1000))) -ForegroundColor Cyan
  $proc=Start-Process -FilePath $stableAudioPython -ArgumentList $argLine -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
  if(-not $proc.WaitForExit($stableAudioTimeout*1000)){Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue;throw "Stable Audio 3 hat das Zeitlimit von $stableAudioTimeout Sekunden überschritten."}
  # An empty redirected stderr file is represented as $null by Windows PowerShell;
  # normalize it before calling .Trim().  Likewise, a fully completed process can
  # expose no ExitCode through Start-Process even though the WAV and JSON success
  # response exist.  The output file is the decisive success signal here.
  $stderrRaw = if(Test-Path $stderr){ Get-Content -LiteralPath $stderr -Raw } else { '' }
  $stderrText = if ($null -eq $stderrRaw) { '' } else { ([string]$stderrRaw).Trim() }
  $exitCode=$null;try{$exitCode=$proc.ExitCode}catch{}
  if(($null -ne $exitCode -and [int]$exitCode -ne 0) -or -not(Test-Path -LiteralPath $output)){throw "Stable Audio 3 fehlgeschlagen (Code $exitCode). $stderrText"}
  return $output
}
function Process-AudioCueJob($payload) {
  $job=$payload.job;$cue=$payload.cue;$root=Join-Path $runtimeRoot ("jobs\audio-cue-{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $root|Out-Null
  if(-not $ffmpegExe){throw 'ffmpeg fehlt; Audio-Spuren können nicht auf den Produktionsstandard normalisiert werden.'}
  Free-Models $config.ComfyUrl;Free-Models $config.H3Url
  if($cue.kind -eq 'dialogue' -or $cue.kind -eq 'narration') {
    # Stable Audio and Qwen share the local GPU. Release Stable Audio before a
    # speech job so dialogue does not fail because of stale VRAM allocations.
    if($stableAudioRef) {
      $stable=Get-PinokioStatus $stableAudioRef
      if($stable -and $stable.running) {
        Write-Host 'Stable Audio wird für die Sprachspur kontrolliert beendet …' -ForegroundColor DarkYellow
        try { Invoke-PtermBounded 'stop' 90 $stableAudioRef | Out-Null; Start-Sleep -Seconds 4 } catch { Write-Warning "Stable Audio konnte nicht sauber beendet werden: $($_.Exception.Message)" }
      }
    }
    $raw=Join-Path $root 'speech-raw.wav'
    [void](Invoke-QwenSpeech -SpeechJobs @([pscustomobject]@{id=$cue.id;text=$cue.text;voice=$cue.voice_profile_id;performance=$cue.performance_direction;language=$cue.language;output=$raw}) -JobRoot $root)
  } elseif($cue.kind -eq 'sfx' -or $cue.kind -eq 'music' -or $cue.kind -eq 'ambience') {
    $raw=Invoke-StableAudioCue $cue $root
  } else { throw "Unbekannter Audio-Cue-Typ: $($cue.kind)" }
  if(-not (Test-Path -LiteralPath $raw)){throw 'Die Audio-Engine meldete Erfolg, aber die WAV-Datei fehlt.'}
  $normal=Join-Path $root 'audio-ready.wav'
  $audioFilter='loudnorm=I=-22:TP=-2:LRA=9'
  if($cue.kind -eq 'dialogue' -or $cue.kind -eq 'narration'){
    $direction=([string]$cue.performance_direction).ToLowerInvariant()
    $tempo=1.0
    if($direction -match 'sehr schnell|panisch|hektisch|atemlos|eilig'){$tempo=1.15}
    elseif($direction -match 'schnell|aufgeregt|dringlich'){$tempo=1.08}
    elseif($direction -match 'langsam|ruhig|bedacht|besonnen'){$tempo=0.94}
    $gain=if($direction -match 'sehr laut|schrei'){'2.5dB'}elseif($direction -match 'laut'){'1.5dB'}elseif($direction -match 'leise|flüster'){'-2.5dB'}else{'0dB'}
    $rawDuration=Get-ClipDurationSeconds $raw
    $targetSeconds=[Math]::Max(0.65,([double]$cue.target_duration_ms/1000))
    # Qwen's natural pause length varies per voice.  Calculate the required
    # pace explicitly as doubles; without the casts PowerShell may retain a
    # culture-sensitive value and skip the adaptive pace calculation.
    $requiredTempo=1.0
    if($null -ne $rawDuration -and [double]$rawDuration -gt [double]$targetSeconds){
      $requiredTempo=[double]$rawDuration/[double]$targetSeconds
      # Beyond ~1.12x speech sounds rushed. A longer line now extends its shot instead
      # (lip sync renders the picture from the voice), so no dialogue is ever rejected.
      $tempo=[Math]::Max([double]$tempo,[Math]::Min(1.12,[double]$requiredTempo))
    }
    $fittedDuration=if($null -ne $rawDuration){[double]$rawDuration/[double]$tempo}else{$targetSeconds}
    Write-Host ("Dialog-Timing: roh {0:N2}s, Ziel {1:N2}s, Tempo {2:N2}x" -f $rawDuration,$targetSeconds,$tempo) -ForegroundColor DarkGray
    $speechSeconds=$null
    if($fittedDuration -gt ($targetSeconds+0.05)){
      Write-Host ("Dialog laenger als geplant ({0:N2}s statt {1:N2}s): Shot wird serverseitig verlaengert." -f $fittedDuration,$targetSeconds) -ForegroundColor Cyan
      $targetSeconds=[Math]::Round([double]$fittedDuration+0.05,3)
      $speechSeconds=$targetSeconds
    }
    $tempoText=$tempo.ToString([Globalization.CultureInfo]::InvariantCulture)
    $audioFilter="atempo=$tempoText,volume=$gain,loudnorm=I=-18:TP=-1.5:LRA=7,apad=pad_dur=$($targetSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)),atrim=duration=$($targetSeconds.ToString([Globalization.CultureInfo]::InvariantCulture))"
  }
  & $ffmpegExe -y -loglevel error -i $raw -af $audioFilter -ar 48000 -ac 2 -c:a pcm_s16le $normal 2>&1|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $normal)){throw 'ffmpeg konnte die Audio-Spur nicht in 48 kHz Stereo normalisieren.'}
  $headers=Headers;$headers['x-framecut-cue-id']=[string]$cue.id
  if($speechSeconds){$headers['x-framecut-speech-seconds']=([double]$speechSeconds).ToString([Globalization.CultureInfo]::InvariantCulture)}
  $lastUploadError=$null
  for($uploadAttempt=1;$uploadAttempt -le 3;$uploadAttempt++) {
    try {
      Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/audio-cue" -Headers $headers -ContentType 'audio/wav' -InFile $normal | Out-Null
      $lastUploadError=$null; break
    } catch {
      $lastUploadError=$_.Exception
      if($uploadAttempt -lt 3) {
        Write-Warning ("Audio-Upload unterbrochen; erneuter Versuch {0}/3 in 3 Sekunden." -f ($uploadAttempt+1))
        Start-Sleep -Seconds 3
      }
    }
  }
  if($lastUploadError){throw "Audio-Upload nach 3 Versuchen fehlgeschlagen: $($lastUploadError.Message)"}
  Write-Host ("Audio-Spur fertig: {0}" -f $cue.id) -ForegroundColor Green
}
function Process-AudioPreviewJob($payload) {
  $job=$payload.job;$asset=$payload.asset;$root=Join-Path $runtimeRoot ("jobs\audio-preview-{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $root|Out-Null
  Free-Models $config.ComfyUrl;Free-Models $config.H3Url
  $out=Join-Path $root 'voice-preview.wav'
  $result=Invoke-QwenSpeech -SpeechJobs @([pscustomobject]@{id='preview';text=$payload.preview.text;voice=$payload.preview.voice;language=$payload.preview.language;output=$out}) -JobRoot $root
  if(-not (Test-Path -LiteralPath $out)){throw 'Qwen3-TTS meldete Erfolg, aber die Stimmprobe fehlt.'}
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/audio-preview" -Headers (Headers) -ContentType 'audio/wav' -InFile $out | Out-Null
  Write-Host ("Stimmprobe fertig: {0}" -f $asset.name) -ForegroundColor Green
}
function Process-AudioMixJob($payload) {
  $job=$payload.job;$root=Join-Path $runtimeRoot ("jobs\audio-mix-{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $root|Out-Null
  if(-not $ffmpegExe){throw 'ffmpeg fehlt; ein Audio-Master kann nicht gemischt werden.'}
  Free-Models $config.ComfyUrl;Free-Models $config.H3Url
  $clips=@($payload.clips|Sort-Object sequence)
  $targetWidth=if($payload.outputProfile.width){[int]$payload.outputProfile.width}else{768}
  $targetHeight=if($payload.outputProfile.height){[int]$payload.outputProfile.height}else{448}
  $targetFps=if($payload.outputProfile.fps){[int]$payload.outputProfile.fps}else{24}
  if($targetWidth -lt 320 -or $targetHeight -lt 180){throw 'Ungültiges Masterprofil: Die Exportauflösung ist zu klein.'}
  $concat=Join-Path $root 'clips.txt';$clipLines=@();$total=0.0
  foreach($clip in $clips){
    $sequence=[int]$clip.sequence
    $duration=[Math]::Max(0.1,[double]$clip.duration_seconds)
    $local=Join-Path $root ("clip-{0:d3}-source.mp4" -f $sequence)
    $normalized=Join-Path $root ("clip-{0:d3}-normalized.mp4" -f $sequence)
    Invoke-WebRequest -Uri ($config.ServerUrl+$clip.downloadUrl) -Headers (Headers) -OutFile $local
    $sourceWidth=0;$sourceHeight=0
    if($ffprobeExe){
      $dimensions=& $ffprobeExe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $local 2>$null
      if($LASTEXITCODE -eq 0 -and ($dimensions -join '') -match '^(\d+)x(\d+)$'){$sourceWidth=[int]$Matches[1];$sourceHeight=[int]$Matches[2]}
    }
    Write-Host ("Clip {0:000}: {1}x{2} -> {3}x{4}, {5:N1}s, ohne Modellton" -f $sequence,$sourceWidth,$sourceHeight,$targetWidth,$targetHeight,$duration) -ForegroundColor DarkCyan
    $durationText=$duration.ToString([Globalization.CultureInfo]::InvariantCulture)
    # Every source becomes an independent, closed GOP H.264 clip with the exact
    # master geometry and authored duration. This prevents 192x160 preview/reference
    # SPS data from corrupting the following 768x448 clips during concat.
    $videoFilter="scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${targetFps},tpad=stop_mode=clone:stop_duration=${durationText},trim=duration=${durationText},setpts=PTS-STARTPTS,format=yuv420p"
    & $ffmpegExe -y -loglevel error -i $local -map 0:v:0 -vf $videoFilter -an -c:v libx264 -preset medium -crf 18 -g ($targetFps*2) -keyint_min ($targetFps*2) -sc_threshold 0 -movflags +faststart $normalized 2>&1|Out-Null
    if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $normalized)){throw ("Clip {0} konnte nicht auf das Masterprofil normalisiert werden." -f $sequence)}
    $clipLines += "file '$($normalized.Replace("'","'\''"))'"
    $total += $duration
  }
  if($total -le 0){throw 'Die Video-Timeline hat keine gültige Dauer.'}
  # FFmpeg's concat demuxer treats a UTF-8 BOM as part of its first keyword
  # ("\ufefffile"), so emit plain UTF-8 explicitly rather than PowerShell 5.1's
  # BOM-prefixed Set-Content encoding.
  [IO.File]::WriteAllText($concat,($clipLines -join "`n"),(New-Object Text.UTF8Encoding($false)))
  $video=Join-Path $root 'picture-cut.mp4';& $ffmpegExe -y -loglevel error -f concat -safe 0 -i $concat -map 0:v:0 -c:v copy -an -movflags +faststart $video 2>&1|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $video)){throw 'Der Bildschnitt für den Audio-Mix konnte nicht erstellt werden.'}
  $tracks=@($payload.audio.manifest.cues|Where-Object {$_.state -eq 'ready' -and $_.artifact.downloadUrl})
  if($tracks.Count -eq 0){throw 'Keine bestätigten externen Audio-Spuren vorhanden. MiniMax-Modellton wird aus Qualitätsgründen nicht als Master verwendet.'}
  $index=0;foreach($cue in $tracks){$index++;$cue|Add-Member -NotePropertyName local_path -NotePropertyValue (Join-Path $root ("cue-{0:d3}.wav" -f $index)) -Force;Invoke-WebRequest -Uri ($config.ServerUrl+$cue.artifact.downloadUrl) -Headers (Headers) -OutFile $cue.local_path}
  $args=@('-y','-loglevel','error','-i',$video);foreach($cue in $tracks){$args += @('-i',$cue.local_path)}
  # The mix always starts from silence. MiniMax native speech/music is deliberately
  # discarded; only separately rendered and reviewable dialogue/SFX/music cues enter.
  $filters=@("anullsrc=r=48000:cl=stereo,atrim=duration=$([Math]::Round($total,3).ToString([Globalization.CultureInfo]::InvariantCulture))[base]")
  $musicLabels=@();$foregroundLabels=@('[base]')
  for($i=0;$i -lt $tracks.Count;$i++){
    $n=$i+1;$cue=$tracks[$i];$delay=[int]$cue.start_ms;$duration=[Math]::Max(1,([double]$cue.target_duration_ms/1000));$gain=if($null -ne $cue.gain_db){[double]$cue.gain_db}else{0}
    $loop=if($cue.kind -eq 'music' -or $cue.kind -eq 'ambience'){'aloop=loop=-1:size=2147483647,'}else{''}
    # In a double-quoted PowerShell string `$n:a` means a scoped variable and
    # `` `a`` is an ANSI escape character.  Build the FFmpeg input label and
    # `atrim` filter explicitly so the graph gets `[1:a]...atrim`, not `[]...`.
    $filters += ("[{0}:a]aresample=48000,{1}atrim=duration={2},volume={3}dB,adelay={4}|{4}[a{0}]" -f $n,$loop,$duration.ToString([Globalization.CultureInfo]::InvariantCulture),$gain.ToString([Globalization.CultureInfo]::InvariantCulture),$delay)
    if($cue.kind -eq 'music' -or $cue.kind -eq 'ambience'){$musicLabels += "[a$n]"}else{$foregroundLabels += "[a$n]"}
  }
  if($musicLabels.Count -gt 0){$filters += ("{0}amix=inputs={1}:duration=longest:normalize=0[bed]" -f ($musicLabels -join ''),$musicLabels.Count)}
  # Use short, unambiguous labels.  Some FFmpeg builds misinterpret the word
  # "foreground" as a stream specifier when it is reused as a sidechain input.
  $filters += ("{0}amix=inputs={1}:duration=longest:normalize=0[fg]" -f ($foregroundLabels -join ''),$foregroundLabels.Count)
  if($musicLabels.Count -gt 0){
    # A filter output can only be consumed once.  Split foreground audio: one
    # branch controls ducking, the other remains audible in the final mix.
    $filters += '[fg]asplit=2[fg_side][fg_mix]'
    $filters += '[bed][fg_side]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=450[duck]'
    $filters += '[duck][fg_mix]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]'
  }else{$filters += '[fg]loudnorm=I=-16:TP=-1.5:LRA=11[mix]'}
  $master=Join-Path $root 'audio-master.mp4';$args += @('-filter_complex',($filters -join ';'),'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-ar','48000','-b:a','192k','-t',([Math]::Round($total,3).ToString([Globalization.CultureInfo]::InvariantCulture)),'-movflags','+faststart',$master)
  & $ffmpegExe @args 2>&1|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $master)){throw 'ffmpeg konnte den Stimmen-Mix nicht erstellen.'}
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/audio-master" -Headers (Headers) -ContentType 'video/mp4' -InFile $master | Out-Null
  Write-Host 'Audio-Master fertig.' -ForegroundColor Green
}
function Process-Job($payload) {
  $job=$payload.job; $shot=$payload.shot
  Write-Host ("Job {0}: {1} / {2} / Shot {3:00} - {4}" -f $job.id,$job.project_title,$job.episode_title,$shot.sequence,$shot.title) -ForegroundColor Green
  if(-not $shot.prompt){throw 'Dieser Shot hat keinen Video-Prompt.'}
  # H3 and the image worker share the 8 GB GPU. Explicitly evict any H3 model before
  # the Z-Image keyframe load; otherwise ComfyUI can remain queued behind stale VRAM.
  Free-Models $config.H3Url
  Free-Models $config.ComfyUrl
  $jobRoot=Join-Path $runtimeRoot ("jobs\{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $jobRoot|Out-Null
  # A new immutable contract and fresh downloads for EVERY job. No text-only
  # keyframe, name matching, first-nine truncation or legacy approved-keyframe cache.
  $contract=$payload.sceneContract
  if(-not $contract -or [int]$contract.version -ne 4){throw 'Server/Worker inkompatibel: Szenenvertrag v4 fehlt.'}
  $cleanRefs=@()
  $pictureNumber=0
  if($useH3ReferenceConditioning -and $contract.rawReferenceImages -eq $true){
    foreach($item in @($contract.references)){
      foreach($photo in @($item.photos)){
        $pictureNumber++
        $localRef=Join-Path $jobRoot ("reference-{0}-{1}.png" -f $pictureNumber,[guid]::NewGuid().ToString('N'))
        Invoke-WebRequest -Uri ($config.ServerUrl+$photo.downloadUrl) -Headers (Headers) -OutFile $localRef
        $actualHash=Get-Sha256Hex $localRef
        if($actualHash -ne [string]$photo.sha256){throw 'Referenzfoto wurde während des Downloads verändert. Auftrag bitte neu starten.'}
        $cleanRefs+=$localRef
      }
    }
  } else { Write-Host 'Roh-Referenzbilder sind für MiniMax deaktiviert; es wird nur der vollflächige Szenenguide animiert.' -ForegroundColor Cyan }
  if($cleanRefs.Count -gt 9){throw 'Mehr als 9 Referenzfotos: Szene aufteilen; keine Referenzen werden ausgelassen.'}
  foreach($warning in @($contract.warnings)){Write-Host $warning -ForegroundColor Yellow}
  $sceneKeyframe=$null
  if($cleanRefs.Count -eq 0 -or $config.UseGeneratedSceneGuide -ne $false){
    # H3 Ref2VA must receive a separate composition guide. Without it the first
    # semantic reference can become frame 0 (character sheet/contact-sheet bug).
    # The keyframe establishes composition and the project look. Identity remains
    # controlled by H3's freshly downloaded reference photos, never by embedding a
    # reference card as frame zero. Keep audio instructions out of this still-image
    # prompt, but always retain the locked episode style.
    $guidePrompt = Get-SharedSceneGuidePrompt $contract $shot
    # A guide controls framing only; it is deliberately low-resolution and quick.
    # H3 receives the real reference photos independently and renders the final
    # preview/final resolution, so this does not trade away character fidelity.
    $guideNegative=(@([string]$job.negative_prompt,'character sheet','model sheet','reference image','turnaround','split screen','collage','portrait insert','white studio panel','white background','border','cutout')|Where-Object {$_}) -join ', '
    $sceneKeyframe=$null
    for($guideAttempt=1;$guideAttempt -le 3;$guideAttempt++){
      $guideSeed=[int]$shot.seed+(($guideAttempt-1)*7919)
      # Episode quality settings (empty = proven defaults: 4 steps, cfg 1.0).
      $guideSteps=if($job.guide_steps){[int]$job.guide_steps}else{4}
      $guideCfg=if($job.guide_cfg){[double]$job.guide_cfg}else{1.0}
      $candidate=Invoke-ZImage $guidePrompt ("framecut-v2/scene-job-{0}" -f [int]$job.id) $guideSeed $guideSteps $guideNegative 512 320 $guideCfg
      if(-not (Test-KeyframeHasWhiteStudioBackground $candidate)){$sceneKeyframe=$candidate;break}
      Write-Host ("Szenenguide Versuch {0}/3 enthielt eine Referenzkarte; neuer Guide wird erzeugt ..." -f $guideAttempt) -ForegroundColor Yellow
      Remove-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    }
    if(-not $sceneKeyframe){throw 'Szenenguide enthält nach drei Versuchen noch einen weißen Referenzhintergrund; bitte Szenenprompt oder Referenzen prüfen.'}
  }
  Free-Models $config.ComfyUrl
  Stop-OwnedComfy
  Ensure-H3
  $promptFile=Join-Path $jobRoot 'prompt.txt'
  [IO.File]::WriteAllText($promptFile,[string]$contract.prompt,(New-Object Text.UTF8Encoding($false)))
  $contract|ConvertTo-Json -Depth 15|Set-Content -LiteralPath (Join-Path $jobRoot 'scene-contract.json') -Encoding utf8
  $outputDir=Join-Path $runtimeRoot ("outputs-v2\project-{0}\episode-{1}" -f $job.project_id,$job.episode_number);New-Item -ItemType Directory -Force -Path $outputDir|Out-Null
  # H3 only accepts 5 + 17n frames. Round() created clips shorter than the authored shot
  # (for example 4.0s became 3.75s). Ceiling keeps the production timeline conservative:
  # a requested duration is never silently cut short, and ffprobe records the true value.
  $frames=5+(17*[Math]::Max(1,[Math]::Ceiling(([Math]::Min(15,[double]$shot.duration_seconds)*24-5)/17)))
  $name=("shot-{0:d3}-job-{1}" -f [int]$shot.sequence,[int]$job.id)
  $isPreview = $shot.render_tier -eq 'Vorschau'
  $renderWidth = if ($isPreview) { if($job.preview_width){[int]$job.preview_width}else{384} } else { if($job.final_width){[int]$job.final_width}else{768} }
  $renderHeight = if ($isPreview) { if($job.preview_height){[int]$job.preview_height}else{224} } else { if($job.final_height){[int]$job.final_height}else{448} }
  $videoSteps = if($job.video_steps){[int]$job.video_steps}elseif($isPreview){4}else{10}
  Write-Host ("Qualitaet: {0} ({1}x{2}, {3} Steps)" -f $shot.render_tier,$renderWidth,$renderHeight,$videoSteps) -ForegroundColor DarkCyan
  # Lip sync: the shot's finished Qwen dialogue is placed at its offsets and handed to H3
  # as an audio guide, so mouths follow the real voice instead of invented speech.
  $promptText=[string]$contract.prompt
  $noAudioLine='One continuous shot; no cuts. Do not generate dialogue, narration or music. Production audio is created and quality-checked separately.'
  # Guides are either spoken lines (lip sync) or, for a shot without dialogue, the shot's
  # own scene sound so H3 has no silent gap to fill with invented speech.
  $guideLines=@($payload.dialogueAudio | Where-Object { $_ -and $_.downloadUrl })
  $dialogueLines=@($guideLines | Where-Object { [string]$_.kind -ne 'ambience' })
  $speechGuide=$null
  $fittedSeconds=$null
  if($guideLines.Count -gt 0 -and $ffmpegExe){
    $guideInputs=@();$guideFilters=@();$labels='';$n=0;$speechEnd=0.0
    foreach($line in $guideLines){
      $local=Join-Path $jobRoot ("dialogue-{0}.wav" -f $n)
      Invoke-WebRequest -Uri ($config.ServerUrl+$line.downloadUrl) -Headers (Headers) -OutFile $local
      $lineSeconds=Get-ClipDurationSeconds $local
      if([string]$line.kind -ne 'ambience' -and $null -ne $lineSeconds){$speechEnd=[Math]::Max($speechEnd,([double]$line.offset_ms/1000)+$lineSeconds)}
      $guideInputs+=@('-i',$local)
      $guideFilters+=("[{0}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={1}|{1}[d{0}]" -f $n,[int]$line.offset_ms)
      $labels+="[d$n]";$n++
    }
    # H3 invents further speech for any part of the clip without a supplied voice, so a
    # dialogue shot ends shortly after its last word (on the 17k+5 frame grid).
    if($speechEnd -gt 0){
      $fitFrames=5+(17*[Math]::Max(1,[Math]::Ceiling((($speechEnd+0.45)*24-5)/17)))
      if($fitFrames -lt $frames){
        Write-Host ("Dialog-Shot auf Satzlaenge gekuerzt: {0:N2}s -> {1:N2}s" -f ([double]$frames/24),([double]$fitFrames/24)) -ForegroundColor Cyan
        $frames=$fitFrames;$fittedSeconds=[double]$fitFrames/24
      }
    }
    $clipText=([double]$frames/24).ToString([Globalization.CultureInfo]::InvariantCulture)
    $speechGuide=Join-Path $jobRoot 'speech-guide.wav'
    $guideFilter=($guideFilters -join ';')+(";{0}amix=inputs={1}:normalize=0:duration=longest,apad=whole_dur={2},atrim=duration={2}[g]" -f $labels,$n,$clipText)
    & $ffmpegExe -y -loglevel error @guideInputs -filter_complex $guideFilter -map '[g]' -ar 48000 -ac 2 $speechGuide 2>&1|Out-Null
    if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $speechGuide)){
      Write-Warning 'Sprachfuehrung konnte nicht erstellt werden; Clip wird ohne Lippensynchronisierung gerendert.'
      $speechGuide=$null;$fittedSeconds=$null
    } elseif($dialogueLines.Count -eq 0) {
      $promptText=$promptText.Replace($noAudioLine,'One continuous shot; no cuts.')+' Nobody speaks in this shot: every character keeps the mouth closed, no talking, no lip movement. The only sound is the provided natural scene ambience and effects.'
      Write-Host 'Stummer Shot: Szenenton fuehrt H3 (keine erfundene Sprache).' -ForegroundColor Cyan
    } else {
      $spoken=($dialogueLines|ForEach-Object { if([string]$_.speaker){'{0} says in German: "{1}"' -f $_.speaker,$_.text}else{'A voice says in German: "{0}"' -f $_.text} }) -join ' Then '
      $speakers=(@($dialogueLines|ForEach-Object{[string]$_.speaker}|Where-Object{$_}|Select-Object -Unique) -join ' and ')
      if(-not $speakers){$speakers='the speaker'}
      $promptText=$promptText.Replace($noAudioLine,'One continuous shot; no cuts.')+(" DIALOGUE, lip-synchronised to the provided speech audio: {0} Only {1} moves the lips, exactly in time with the words; every other character keeps the mouth closed. When the words end, the mouth closes. No music, no other voices." -f $spoken,$speakers)
      Write-Host ("Lippensynchron: {0} Dialogzeile(n) fuehren H3 ({1})." -f $dialogueLines.Count,$speakers) -ForegroundColor Cyan
    }
  } else {
    $promptText+=' Nobody speaks in this shot: every character keeps the mouth closed, no talking, no lip movement.'
  }
  [IO.File]::WriteAllText($promptFile,$promptText,(New-Object Text.UTF8Encoding($false)))
  $renderArgs=@($renderClient,'--base-url',$config.H3Url,'--prompt-file',$promptFile,'--output-dir',$outputDir,'--name',$name,'--width',[string]$renderWidth,'--height',[string]$renderHeight,'--frames',[string]$frames,'--steps',[string]$videoSteps,'--seed',[string]([int]$shot.seed),'--low-vram')
  if($sceneKeyframe){$renderArgs += @('--image',$sceneKeyframe)}
  if($speechGuide){$renderArgs += @('--guide-audio',$speechGuide)}
  foreach($refPath in $cleanRefs){$renderArgs += @('--reference-image',$refPath)}
  if($cleanRefs.Count -gt 0){
    $renderArgs += @('--reference-image-size',$h3ReferenceImageSize)
    Write-Host ("Referenzgeführte Szene ohne falsches Text-Startbild: {0} Fotos" -f $cleanRefs.Count) -ForegroundColor Cyan
  }
  $renderTimeout=if($config.RenderTimeoutSeconds){[Math]::Max(300,[int]$config.RenderTimeoutSeconds)}else{1800}
  Invoke-BoundedPython $renderArgs $renderTimeout 'MiniMax H3'
  $result=Get-ChildItem -LiteralPath $outputDir -Filter "$name*.mp4"|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw 'MiniMax H3 meldete Erfolg, aber es wurde keine MP4-Datei gefunden.'}
  # The model always generates an audio track and its speech/music output is unusable, so the
  # clip is delivered silent. Dialogue, SFX and score are meant to be added as separate layers.
  if($stripAudio){
    $silent=Join-Path $jobRoot 'render-silent.mp4'
    & $ffmpegExe -y -loglevel error -i $result.FullName -f lavfi -i anullsrc=r=48000:cl=stereo -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 128k -shortest $silent 2>&1 | Out-Null
    if($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $silent)){
      $result=Get-Item -LiteralPath $silent
      Write-Host 'Tonspur entfernt (stumm ausgeliefert).' -ForegroundColor DarkCyan
    } else {
      Write-Host 'Warnung: Tonspur konnte nicht entfernt werden, Clip wird mit Originalton geliefert.' -ForegroundColor Yellow
    }
  }
  $actualDuration=Get-ClipDurationSeconds $result.FullName
  $videoHeaders=Headers
  $videoHeaders['x-framecut-scene-fingerprint']=[string]$contract.fingerprint
  if($fittedSeconds -and $actualDuration){$videoHeaders['x-framecut-fitted-seconds']=([Math]::Round([double]$actualDuration,3)).ToString([Globalization.CultureInfo]::InvariantCulture)}
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/video" -Headers $videoHeaders -ContentType 'video/mp4' -InFile $result.FullName | Out-Null
  if($null -ne $actualDuration){
    $requestedDuration=[double]$shot.duration_seconds
    $delta=[Math]::Abs($actualDuration-$requestedDuration)
    $durationDetail=("Clip lokal gerendert. Gewünscht: {0:N1}s · tatsächlich: {1:N2}s" -f $requestedDuration,$actualDuration)
    if($delta -gt 0.35){$durationDetail += (" · Abweichung: {0:N2}s (H3-Frame-Raster)" -f $delta)}
    Report-Job $job.id 'complete' $durationDetail
  }
  # The server has acknowledged the uploaded project clip. The H3 original inside
  # outputs-v2 is now only a local duplicate, so remove that single file as well.
  # The job workspace is removed by the caller after this function returns.
  if ($result -and (Test-Path -LiteralPath $result.FullName)) {
    Remove-Item -LiteralPath $result.FullName -Force -ErrorAction SilentlyContinue
  }
  Write-Host ("Fertig: {0}" -f $result.FullName) -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Invoke-ExpiredWorkspaceCleanup
$transcriptStarted=$false
try { Start-Transcript -LiteralPath (Join-Path $runtimeRoot 'worker.log') -Append | Out-Null; $transcriptStarted=$true } catch {}
# Two workers would fight over the same jobs and the same GPU.  A named mutex is the
# authority here: unlike a PID file it cannot be removed by an older worker that is
# only just finishing while a new one is starting.
$workerMutex = New-Object System.Threading.Mutex($false, 'Local\FrameCutLocalRenderWorker')
$ownsWorkerMutex = $false
try {
  $ownsWorkerMutex = $workerMutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
  # The previous process crashed, so Windows hands ownership to this process.
  $ownsWorkerMutex = $true
}
if (-not $ownsWorkerMutex) {
  Write-Host 'Es laeuft bereits ein FrameCut-Worker. Dieser Start wird beendet.' -ForegroundColor Yellow
  if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
  $workerMutex.Dispose()
  exit 0
}
# Keep the PID file as a human-readable diagnostic, but never use it as the lock.
if (Test-Path -LiteralPath $pidPath) {
  $existingPid = 0
  [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$existingPid) | Out-Null
  if ($existingPid -gt 0 -and $existingPid -ne $PID) {
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId=$existingPid" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -match 'FrameCut-Worker') {
      Write-Host ("Es laeuft bereits ein FrameCut-Worker (PID {0}). Dieser Start wird beendet." -f $existingPid) -ForegroundColor Yellow
      if ($transcriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
      exit 0
    }
  }
}
Set-Content -LiteralPath $pidPath -Value $PID -Encoding ascii
Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
$Host.UI.RawUI.WindowTitle='FrameCut Worker - aktiv'
Set-Awake $true
Write-Host 'FrameCut Worker ist aktiv. Der Computer bleibt wach; der Bildschirm darf sich ausschalten.' -ForegroundColor Red
Write-Host ("Server: {0} | Worker: {1} | Version: {2}" -f $config.ServerUrl,$config.WorkerId,$workerVersion) -ForegroundColor Gray
Report-WorkerVersion
try {
  do {
    if(Test-Path -LiteralPath $stopPath){break}
    # Renew the execution request on every poll. This is intentionally separate from the
    # permanent AC power-plan setting: either safeguard may be reset by Windows updates
    # or vendor power-management software, but both together keep a remote render host awake.
    Set-Awake $true
    try {
      # Updates are only considered before a job is claimed, therefore a render is
      # never interrupted. The detached updater waits for this process to exit,
      # verifies the server-provided SHA-256 and relaunches the worker.
      $pendingUpdate=Get-PendingWorkerUpdate
      if($pendingUpdate){Start-WorkerUpdate $pendingUpdate;break}
      Invoke-ExpiredWorkspaceCleanup
      if (Test-WorkerStorageAvailable) {
        $payload=Invoke-RestMethod -Method Get -Uri "$($config.ServerUrl)/api/worker/next" -Headers (Headers)
        if($payload){try{if($payload.job.kind -eq 'comfyui_reference_preview'){Process-ImageJob $payload}elseif($payload.job.kind -eq 'caption_asset'){Process-CaptionJob $payload}elseif($payload.job.kind -eq 'audio_preview'){Process-AudioPreviewJob $payload}elseif($payload.job.kind -eq 'audio_cue'){Process-AudioCueJob $payload}elseif($payload.job.kind -eq 'audio_mix'){Process-AudioMixJob $payload}else{Process-Job $payload};Remove-ConfirmedJobWorkspace $payload.job}catch{
          $failure = if ($_ -and $_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message } elseif ($_){ [string]$_ } else { 'Unbekannter Worker-Fehler.' }
          $stack = if ($_ -and $_.ScriptStackTrace) { [string]$_.ScriptStackTrace } else { '' }
          if ($stack) { $failure = "$failure`n$stack" }
          Write-Host $failure -ForegroundColor Red
          try { Report-Job $payload.job.id 'fail' $failure } catch { Write-Host ("Fehlerstatus konnte nicht an FrameCut gemeldet werden: {0}" -f ([string]$_)) -ForegroundColor Red }
        }}
      }
    } catch {Write-Host ("Verbindung wartet: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow}
    if(-not $Once){for($i=0;$i -lt 10 -and -not (Test-Path -LiteralPath $stopPath);$i++){Start-Sleep -Seconds 1}}
  } while(-not $Once)
} finally {
  Stop-OwnedComfy
  Set-Awake $false
  # An old process must never remove a PID written by a newer process.
  $pidToRemove = 0
  if (Test-Path -LiteralPath $pidPath) {
    [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$pidToRemove) | Out-Null
    if ($pidToRemove -eq $PID) { Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
  if ($ownsWorkerMutex) { try { $workerMutex.ReleaseMutex() } catch {} }
  if ($workerMutex) { $workerMutex.Dispose() }
  Write-Host 'FrameCut Worker wurde sauber beendet. Normaler Energiesparmodus ist wieder aktiv.' -ForegroundColor Gray
  if($transcriptStarted){try{Stop-Transcript|Out-Null}catch{}}
}
