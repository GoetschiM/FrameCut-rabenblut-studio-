param([switch]$Once)

$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeRoot = Join-Path $workerRoot 'data'
$configPath = Join-Path $runtimeRoot 'worker.config.json'
$tokenPath = Join-Path $runtimeRoot 'worker-token.dpapi'
$pidPath = Join-Path $runtimeRoot 'worker.pid'
$stopPath = Join-Path $runtimeRoot 'worker.stop'
$pinokioHome = Join-Path $env:USERPROFILE 'Documents\Pinokio'
$pterm = Join-Path $pinokioHome 'bin\npm\pterm.cmd'

if(-not (Test-Path -LiteralPath $configPath) -or -not (Test-Path -LiteralPath $tokenPath)){Write-Host 'Worker ist noch nicht eingerichtet. Bitte Setup erneut ausfuehren.' -ForegroundColor Yellow;exit 1}
$config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json

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
$qwenModelSize = if ($config.QwenTtsModelSize) { [string]$config.QwenTtsModelSize } else { '1.7B' }
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
$useH3ReferenceConditioning = $config.PSObject.Properties.Name -contains 'UseH3ReferenceConditioning' -and $config.UseH3ReferenceConditioning -eq $true
$ffmpegExe = if ($config.FfmpegPath) { $config.FfmpegPath } else { (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
$ffprobeExe = if ($config.FfprobePath) { $config.FfprobePath } elseif ($ffmpegExe) { Join-Path (Split-Path -Parent $ffmpegExe) 'ffprobe.exe' } else { (Get-Command ffprobe -ErrorAction SilentlyContinue).Source }
if ($stripAudio -and -not $ffmpegExe) {
  Write-Host 'Hinweis: ffmpeg wurde nicht gefunden - Clips behalten ihre Original-Tonspur.' -ForegroundColor Yellow
  $stripAudio = $false
}

if(-not (Test-Path -LiteralPath $pterm)){Write-Host 'Pinokio/pterm wurde nicht gefunden.' -ForegroundColor Yellow;exit 1}
if(-not (Test-Path -LiteralPath $renderClient)){Write-Host 'MiniMax-H3-Client wurde nicht gefunden.' -ForegroundColor Yellow;exit 1}

Add-Type -AssemblyName System.Security

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
  $extraJson = @($ExtraArgs) | ConvertTo-Json -Compress
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
      Write-Host 'pterm run hat das Timeout erreicht.' -ForegroundColor Yellow
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
  $start=Invoke-PtermBounded 'run' 120 $stableAudioRef @('--default',$stableAudioLaunchScript)
  if($start.TimedOut){throw 'Pinokio konnte Stable Audio nicht rechtzeitig starten.'}
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
function Invoke-ZImage([string]$Prompt,[string]$Prefix,[int]$Seed,[int]$Steps=12,[string]$NegativePrompt='') {
  Ensure-Comfy
  $env:COMFY_URL=$config.ComfyUrl
  $imageTimeout=if($config.ImageTimeoutSeconds){[Math]::Max(120,[int]$config.ImageTimeoutSeconds)}else{900}
  $baseNegative='contact sheet, storyboard grid, collage, split screen, multiple panels, model sheet, turnaround sheet, white background, text, caption, watermark, logo, malformed anatomy, duplicate people, extra limbs, flat lighting, open door on a moving vehicle, laptop outside a vehicle, physically impossible vehicle, floating objects'
  $effectiveNegative=if($NegativePrompt){"$baseNegative, $NegativePrompt"}else{$baseNegative}
  try { Invoke-BoundedPython @($imageClient,$Prompt,'--negativ',$effectiveNegative,'--breite','768','--hoehe','448','--schritte',[string]$Steps,'--seed',[string]$Seed,'--name',$Prefix) $imageTimeout 'ComfyUI Z-Image' } finally { Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue }
  $folder=Split-Path $Prefix -Parent
  $leaf=Split-Path $Prefix -Leaf
  $result=Get-ChildItem -LiteralPath (Join-Path $comfyOutputRoot $folder) -Filter "$leaf*.png"|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw "ComfyUI meldete Erfolg, aber $leaf wurde nicht gefunden."}
  return $result.FullName
}
function Invoke-BoundedPython([string[]]$Arguments,[int]$TimeoutSeconds,[string]$Operation) {
  $pythonExe=(Get-Command python -ErrorAction Stop).Source
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
    'text, caption, watermark, malformed anatomy, duplicate person, white background, flat lighting'
  }else{
    'person, people, human, character, face, portrait, body, hands, crowd, text, caption, watermark, white background, flat lighting'
  }
  $env:COMFY_URL=$config.ComfyUrl
  $imageTimeout=if($config.ImageTimeoutSeconds){[Math]::Max(120,[int]$config.ImageTimeoutSeconds)}else{900}
  try { Invoke-BoundedPython @($imageClient,$payload.prompt,'--negativ',$negativePrompt,'--breite','768','--hoehe','432','--schritte',[string]$photoSteps,'--seed',[string](100000+[int]$job.id),'--name',$prefix) $imageTimeout 'ComfyUI Referenzbild' } finally { Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue }
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
    $argLine="`"$qwenClient`" --qwen-app `"$qwenAppPath`" --jobs `"$specPath`" --model-size $qwenModelSize"
    Write-Host ("Qwen3-TTS erzeugt {0} Stimme(n) ..." -f $SpeechJobs.Count) -ForegroundColor Cyan
    $proc=Start-Process -FilePath $qwenPythonExe -ArgumentList $argLine -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -NoNewWindow -PassThru
    if($null -eq $proc){throw 'Qwen3-TTS-Prozess konnte nicht gestartet werden.'}
    $timeout=if($config.AudioTimeoutSeconds){[Math]::Max(600,[int]$config.AudioTimeoutSeconds)}else{7200}
    if(-not $proc.WaitForExit($timeout*1000)){Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue;throw "Qwen3-TTS hat das Zeitlimit von $timeout Sekunden überschritten."}
    $stdout=if(Test-Path $stdoutPath){(Get-Content $stdoutPath -Raw).Trim()}else{''};$stderr=if(Test-Path $stderrPath){(Get-Content $stderrPath -Raw).Trim()}else{''}
    if($proc.ExitCode -ne 0){throw "Qwen3-TTS fehlgeschlagen (Code $($proc.ExitCode)). $stderr"}
    $jsonLine=($stdout -split "`r?`n"|Where-Object {$_ -match '^\{.*\}$'}|Select-Object -Last 1)
    if(-not $jsonLine){throw "Qwen3-TTS lieferte kein Ergebnis. $stdout $stderr"}
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
  @{prompt=[string]$Cue.prompt;duration_seconds=[Math]::Max(1,[Math]::Ceiling(([double]$Cue.target_duration_ms)/1000));output=$output}|ConvertTo-Json -Compress|Set-Content -LiteralPath $spec -Encoding utf8
  $stdout = Join-Path $JobRoot 'stable-audio-stdout.log'; $stderr = Join-Path $JobRoot 'stable-audio-stderr.log'
  $argLine="`"$stableAudioClient`" --base-url `"$baseUrl`" --spec `"$spec`""
  Write-Host ("Stable Audio 3 erzeugt {0} ({1}s) ..." -f $Cue.kind,([Math]::Ceiling(([double]$Cue.target_duration_ms)/1000))) -ForegroundColor Cyan
  $proc=Start-Process -FilePath $stableAudioPython -ArgumentList $argLine -RedirectStandardOutput $stdout -RedirectStandardError $stderr -NoNewWindow -PassThru
  if(-not $proc.WaitForExit($stableAudioTimeout*1000)){Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue;throw "Stable Audio 3 hat das Zeitlimit von $stableAudioTimeout Sekunden überschritten."}
  $stderrText=if(Test-Path $stderr){(Get-Content $stderr -Raw).Trim()}else{''}
  if($proc.ExitCode -ne 0 -or -not(Test-Path -LiteralPath $output)){throw "Stable Audio 3 fehlgeschlagen (Code $($proc.ExitCode)). $stderrText"}
  return $output
}
function Process-AudioCueJob($payload) {
  $job=$payload.job;$cue=$payload.cue;$root=Join-Path $runtimeRoot ("jobs\audio-cue-{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $root|Out-Null
  if(-not $ffmpegExe){throw 'ffmpeg fehlt; Audio-Spuren können nicht auf den Produktionsstandard normalisiert werden.'}
  Free-Models $config.ComfyUrl;Free-Models $config.H3Url
  if($cue.kind -eq 'dialogue' -or $cue.kind -eq 'narration') {
    $raw=Join-Path $root 'speech-raw.wav'
    [void](Invoke-QwenSpeech -SpeechJobs @([pscustomobject]@{id=$cue.id;text=$cue.text;voice=$cue.voice_profile_id;language=$cue.language;output=$raw}) -JobRoot $root)
  } elseif($cue.kind -eq 'sfx' -or $cue.kind -eq 'music' -or $cue.kind -eq 'ambience') {
    $raw=Invoke-StableAudioCue $cue $root
  } else { throw "Unbekannter Audio-Cue-Typ: $($cue.kind)" }
  if(-not (Test-Path -LiteralPath $raw)){throw 'Die Audio-Engine meldete Erfolg, aber die WAV-Datei fehlt.'}
  $normal=Join-Path $root 'audio-ready.wav'
  & $ffmpegExe -y -loglevel error -i $raw -ar 48000 -ac 2 -c:a pcm_s16le $normal 2>&1|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path -LiteralPath $normal)){throw 'ffmpeg konnte die Audio-Spur nicht in 48 kHz Stereo normalisieren.'}
  $headers=Headers;$headers['x-framecut-cue-id']=[string]$cue.id
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/audio-cue" -Headers $headers -ContentType 'audio/wav' -InFile $normal | Out-Null
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
  $concat=Join-Path $root 'clips.txt';$clipLines=@();$total=0.0
  foreach($clip in $clips){$local=Join-Path $root ("clip-{0:d3}.mp4" -f [int]$clip.sequence);Invoke-WebRequest -Uri ($config.ServerUrl+$clip.downloadUrl) -Headers (Headers) -OutFile $local;$clipLines += "file '$($local.Replace("'","'\''"))'";$total += [double]$clip.duration_seconds}
  if($total -le 0){throw 'Die Video-Timeline hat keine gültige Dauer.'}
  Set-Content -LiteralPath $concat -Value ($clipLines -join "`n") -Encoding utf8
  $video=Join-Path $root 'picture-cut.mp4';& $ffmpegExe -y -loglevel error -f concat -safe 0 -i $concat -map 0:v:0 -c:v copy -an $video 2>&1|Out-Null
  if($LASTEXITCODE -ne 0 -or -not(Test-Path $video)){throw 'Der Bildschnitt für den Audio-Mix konnte nicht erstellt werden.'}
  $tracks=@($payload.audio.manifest.cues|Where-Object {$_.state -eq 'ready' -and $_.artifact.downloadUrl})
  if($tracks.Count -eq 0){throw 'Keine bestätigten Audio-Spuren zum Mischen vorhanden.'}
  $index=0;foreach($cue in $tracks){$index++;$cue|Add-Member -NotePropertyName local_path -NotePropertyValue (Join-Path $root ("cue-{0:d3}.wav" -f $index)) -Force;Invoke-WebRequest -Uri ($config.ServerUrl+$cue.artifact.downloadUrl) -Headers (Headers) -OutFile $cue.local_path}
  $args=@('-y','-loglevel','error','-i',$video);foreach($cue in $tracks){$args += @('-i',$cue.local_path)}
  $filters=@("anullsrc=r=48000:cl=stereo,atrim=duration=$([Math]::Round($total,3).ToString([Globalization.CultureInfo]::InvariantCulture))[base]")
  $musicLabels=@();$foregroundLabels=@('[base]')
  for($i=0;$i -lt $tracks.Count;$i++){
    $n=$i+1;$cue=$tracks[$i];$delay=[int]$cue.start_ms;$duration=[Math]::Max(1,([double]$cue.target_duration_ms/1000));$gain=if($null -ne $cue.gain_db){[double]$cue.gain_db}else{0}
    $loop=if($cue.kind -eq 'music' -or $cue.kind -eq 'ambience'){'aloop=loop=-1:size=2147483647,'}else{''}
    $filters += "[$n:a]aresample=48000,$loop`atrim=duration=$($duration.ToString([Globalization.CultureInfo]::InvariantCulture)),volume=$($gain.ToString([Globalization.CultureInfo]::InvariantCulture)),adelay=$delay|$delay[a$n]"
    if($cue.kind -eq 'music' -or $cue.kind -eq 'ambience'){$musicLabels += "[a$n]"}else{$foregroundLabels += "[a$n]"}
  }
  if($musicLabels.Count -gt 0){$filters += ("{0}amix=inputs={1}:duration=longest:normalize=0[bed]" -f ($musicLabels -join ''),$musicLabels.Count)}
  $filters += ("{0}amix=inputs={1}:duration=longest:normalize=0[foreground]" -f ($foregroundLabels -join ''),$foregroundLabels.Count)
  if($musicLabels.Count -gt 0){$filters += '[bed][foreground]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=450[ducked]';$filters += '[ducked][foreground]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[mix]'}else{$filters += '[foreground]loudnorm=I=-16:TP=-1.5:LRA=11[mix]'}
  $master=Join-Path $root 'audio-master.mp4';$args += @('-filter_complex',($filters -join ';'),'-map','0:v:0','-map','[mix]','-c:v','copy','-c:a','aac','-b:a','192k','-t',([Math]::Round($total,3).ToString([Globalization.CultureInfo]::InvariantCulture)),'-movflags','+faststart',$master)
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
  $allRefs=@($shot.references|Where-Object {$_.role -ne 'style'})
  # Assets linked to this shot in the database are a deliberate choice. Prefer the ones the
  # prompt also names, but never drop a linked reference just because the prompt phrased it
  # differently ("the narrator" instead of "Michel") - that silently broke character
  # consistency whenever the wording did not match the asset name exactly.
  $keyframeRefs=@($allRefs|Sort-Object @{Expression={if($shot.prompt -match [regex]::Escape($_.name)){0}else{1}}},@{Expression={[int]$_.id}}|Select-Object -First 3)
  # Every explicitly linked production asset participates in continuity. Characters and
  # props stabilize identity; location anchors keep a recurring world from drifting.
  # The generated shot-start frame already carries composition, so do not re-download it.
  $visualRefs=@($keyframeRefs|Where-Object {$_.kind -ne 'source'}|Select-Object -First 3)
  $assetText=if ($visualRefs.Count -gt 0) { ($visualRefs|ForEach-Object {"$($_.name): $($_.visual_notes)"}) -join ' | ' } else { 'None' }
  $teslaRequested=($shot.prompt -match '(?i)\btesla\b') -or (($visualRefs|Where-Object {$_.name -match '(?i)\btesla\b'}).Count -gt 0)
  $teslaRule=if($teslaRequested){'A Tesla may appear only in the exact role described by the shot.'}else{'ABSOLUTE EXCLUSION: this is a car-free, vehicle-free frame. Show zero cars or other vehicles anywhere: no Tesla, no automobile, no sedan, no SUV, no parked traffic and no road traffic.'}
  $vehicleNegative=if($teslaRequested){''}else{'Tesla, car, automobile, sedan, SUV, vehicle, electric car, parked car, traffic, road traffic'}
  # The server resolves project defaults and episode overrides before handing us a job.
  # Send it to Z-Image as an actual negative conditioning prompt, and phrase it as an
  # explicit exclusion for H3 (which only exposes a positive text field).
  $configuredNegative=if($null -ne $job.negative_prompt){([string]$job.negative_prompt).Replace("`r",' ').Replace("`n",' ').Trim()}else{''}
  $effectiveNegative=@($vehicleNegative,$configuredNegative)|Where-Object {$_}|ForEach-Object {$_.Trim()}|Select-Object -Unique
  $negativePrompt=$effectiveNegative -join ', '
  $negativeRule=if($configuredNegative){"ABSOLUTE USER EXCLUSIONS: Do not show or introduce any of these: $configuredNegative."}else{''}
  $keyframePrompt=("SINGLE FULL-BLEED CINEMATIC FRAME, one continuous image, not a storyboard, not a collage. Opening instant of this exact shot: {0}. Camera: {1}. Continuity metadata only (do not visualize biography, occupations or props unless the shot action explicitly asks for them): {2}. Show only the subjects and objects required by the stated action. {3} {4} Everything must be physically plausible. Exterior views of a moving car show a completely closed body and closed doors; occupants stay hidden behind glass unless the shot explicitly requests an interior or person close-up. Project style: {5}. 16:9 widescreen composition, cinematic depth, realistic coherent anatomy, no visible writing, no subtitles, no border, no reference layout." -f $shot.prompt,$shot.camera,$assetText,$teslaRule,$negativeRule,$job.style_profile).Replace("`r",' ').Replace("`n",' ')
  $approvedKeyframe=Join-Path $runtimeRoot ("approved-keyframes\shot-{0}.png" -f [int]$shot.id)
  $photoSteps=if($job.photo_steps){[int]$job.photo_steps}else{8}
  if(Test-Path -LiteralPath $approvedKeyframe){
    Write-Host ("Geprueften Keyframe wiederverwenden: {0}" -f $approvedKeyframe) -ForegroundColor Cyan
    $sceneKeyframe=$approvedKeyframe
  } else {
    $sceneKeyframe=Invoke-ZImage $keyframePrompt ("framecut-v2/scene-job-{0}" -f [int]$job.id) ([int]$shot.seed) $photoSteps $negativePrompt
  }
  Copy-Item -LiteralPath $sceneKeyframe -Destination (Join-Path $jobRoot 'scene-keyframe.png') -Force
  # H3's reference-to-video graph does not have a real first-frame input. It can reinterpret a
  # character sheet as the opening composition, which caused contact sheets and duplicate people
  # to leak into delivered clips. Keep it disabled unless deliberately enabled in worker config.
  $cleanRefs=@()
  if($useH3ReferenceConditioning){
    foreach($item in $visualRefs){
      $localRef=Join-Path $jobRoot ("identity-{0}" -f [int]$item.id)
      Invoke-WebRequest -Uri ($config.ServerUrl+$item.downloadUrl) -Headers (Headers) -OutFile $localRef
      $cleanRefs+=$localRef
    }
  }
  Free-Models $config.ComfyUrl
  Stop-OwnedComfy
  Ensure-H3
  $promptFile=Join-Path $jobRoot 'prompt.txt'
  $conditioning='The supplied first frame is the exact full-screen composition and opening moment.'
  $identityNote=if($cleanRefs.Count -gt 0){' The additional reference images define the exact appearance of the named people, objects and environments - preserve those faces, clothing, vehicles, architecture and atmosphere.'}else{' The supplied opening frame is the sole visual identity source; preserve every depicted face, hairstyle, outfit, prop and environment exactly.'}
  $fullPrompt=("{0}{1} {2} Camera: {3}. One continuous unbroken shot, no edit, no cut, no sudden viewpoint change. Show exactly one instance of each named character unless the stated action explicitly requires more; never add, clone, replace or merge people. {4} {5} Project style: {6}. The audio track is discarded after rendering, so audio content does not matter." -f $conditioning,$identityNote,$shot.prompt,$shot.camera,$teslaRule,$negativeRule,$job.style_profile)
  Set-Content -LiteralPath $promptFile -Value $fullPrompt -Encoding utf8
  $outputDir=Join-Path $runtimeRoot ("outputs-v2\project-{0}\episode-{1}" -f $job.project_id,$job.episode_number);New-Item -ItemType Directory -Force -Path $outputDir|Out-Null
  # H3 only accepts 5 + 17n frames. Round() created clips shorter than the authored shot
  # (for example 4.0s became 3.75s). Ceiling keeps the production timeline conservative:
  # a requested duration is never silently cut short, and ffprobe records the true value.
  $frames=5+(17*[Math]::Max(1,[Math]::Ceiling(([Math]::Min(15,[double]$shot.duration_seconds)*24-5)/17)))
  $name=("shot-{0:d3}-job-{1}" -f [int]$shot.sequence,[int]$job.id)
  $isPreview = $shot.render_tier -eq 'Vorschau'
  $renderWidth = if ($isPreview) { if($job.preview_width){[int]$job.preview_width}else{384} } else { if($job.final_width){[int]$job.final_width}else{768} }
  $renderHeight = if ($isPreview) { if($job.preview_height){[int]$job.preview_height}else{224} } else { if($job.final_height){[int]$job.final_height}else{448} }
  $videoSteps = if($job.video_steps){[int]$job.video_steps}else{4}
  Write-Host ("Qualitaet: {0} ({1}x{2}, {3} Steps)" -f $shot.render_tier,$renderWidth,$renderHeight,$videoSteps) -ForegroundColor DarkCyan
  $renderArgs=@($renderClient,'--base-url',$config.H3Url,'--image',(Join-Path $jobRoot 'scene-keyframe.png'),'--prompt-file',$promptFile,'--output-dir',$outputDir,'--name',$name,'--width',[string]$renderWidth,'--height',[string]$renderHeight,'--frames',[string]$frames,'--steps',[string]$videoSteps,'--seed',[string]([int]$shot.seed),'--low-vram')
  if($useH3ReferenceConditioning){
    foreach($refPath in $cleanRefs){ $renderArgs += @('--reference-image',$refPath) }
    if($cleanRefs.Count -gt 0){ Write-Host ("H3-Referenzmodus aktiv: {0} Bild(er)" -f $cleanRefs.Count) -ForegroundColor DarkCyan }
  } elseif($visualRefs.Count -gt 0) {
    Write-Host 'H3 bleibt im stabilen Bildstart-Modus; Besetzungsbilder steuern den Keyframe, nicht den ersten Videoframe.' -ForegroundColor DarkCyan
  }
  $renderTimeout=if($config.RenderTimeoutSeconds){[Math]::Max(300,[int]$config.RenderTimeoutSeconds)}else{1800}
  Invoke-BoundedPython $renderArgs $renderTimeout 'MiniMax H3'
  $result=Get-ChildItem -LiteralPath $outputDir -Filter "$name*.mp4"|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw 'MiniMax H3 meldete Erfolg, aber es wurde keine MP4-Datei gefunden.'}
  # The model always generates an audio track and its speech/music output is unusable, so the
  # clip is delivered silent. Dialogue, SFX and score are meant to be added as separate layers.
  if($stripAudio){
    $silent=Join-Path $jobRoot 'render-silent.mp4'
    & $ffmpegExe -y -loglevel error -i $result.FullName -c:v copy -an $silent 2>&1 | Out-Null
    if($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $silent)){
      $result=Get-Item -LiteralPath $silent
      Write-Host 'Tonspur entfernt (stumm ausgeliefert).' -ForegroundColor DarkCyan
    } else {
      Write-Host 'Warnung: Tonspur konnte nicht entfernt werden, Clip wird mit Originalton geliefert.' -ForegroundColor Yellow
    }
  }
  $actualDuration=Get-ClipDurationSeconds $result.FullName
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/video" -Headers (Headers) -ContentType 'video/mp4' -InFile $result.FullName | Out-Null
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
Write-Host ("Server: {0} | Worker: {1}" -f $config.ServerUrl,$config.WorkerId) -ForegroundColor Gray
try {
  do {
    if(Test-Path -LiteralPath $stopPath){break}
    # Renew the execution request on every poll. This is intentionally separate from the
    # permanent AC power-plan setting: either safeguard may be reset by Windows updates
    # or vendor power-management software, but both together keep a remote render host awake.
    Set-Awake $true
    try {
      Invoke-ExpiredWorkspaceCleanup
      if (Test-WorkerStorageAvailable) {
        $payload=Invoke-RestMethod -Method Get -Uri "$($config.ServerUrl)/api/worker/next" -Headers (Headers)
        if($payload){try{if($payload.job.kind -eq 'comfyui_reference_preview'){Process-ImageJob $payload}elseif($payload.job.kind -eq 'caption_asset'){Process-CaptionJob $payload}elseif($payload.job.kind -eq 'audio_preview'){Process-AudioPreviewJob $payload}elseif($payload.job.kind -eq 'audio_cue'){Process-AudioCueJob $payload}elseif($payload.job.kind -eq 'audio_mix'){Process-AudioMixJob $payload}else{Process-Job $payload};Remove-ConfirmedJobWorkspace $payload.job}catch{
          $failure = if ($_ -and $_.Exception -and $_.Exception.Message) { [string]$_.Exception.Message } elseif ($_){ [string]$_ } else { 'Unbekannter Worker-Fehler.' }
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
