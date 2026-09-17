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

# Clips are delivered without sound by default; set StripAudio to false in worker.config.json
# to keep whatever the video model generated.
$stripAudio = -not ($config.PSObject.Properties.Name -contains 'StripAudio' -and $config.StripAudio -eq $false)
$ffmpegExe = if ($config.FfmpegPath) { $config.FfmpegPath } else { (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
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
}
'@

function Set-Awake([bool]$Enabled) {
  if ($Enabled) { [void][FrameCutPower]::SetThreadExecutionState([Convert]::ToUInt32('80000001',16)) }
  else { [void][FrameCutPower]::SetThreadExecutionState([Convert]::ToUInt32('80000000',16)) }
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
function Ensure-H3 {
  $status = $null
  try { $status = (& $pterm status $config.H3Ref --probe | ConvertFrom-Json) } catch {}
  if ($status.ready) { return }
  Write-Host 'MiniMax H3 wird ueber Pinokio gestartet ...' -ForegroundColor Cyan
  # pterm run has no built-in timeout and can hang indefinitely (e.g. if Pinokio itself
  # is wedged) with zero error, silently freezing the whole worker loop. Bound it.
  $startJob = Start-Job -ScriptBlock { param($ptermPath,$ref) & $ptermPath run $ref | Out-Null } -ArgumentList $pterm,$config.H3Ref
  $finished = Wait-Job -Job $startJob -Timeout 60
  if (-not $finished) {
    Stop-Job -Job $startJob -ErrorAction SilentlyContinue
    Remove-Job -Job $startJob -Force -ErrorAction SilentlyContinue
    throw 'pterm run (MiniMax H3 Start) hat nach 60 Sekunden nicht reagiert - Pinokio haengt vermutlich fest.'
  }
  Remove-Job -Job $startJob -Force -ErrorAction SilentlyContinue
  for($attempt=0;$attempt -lt 60;$attempt++){
    Start-Sleep -Seconds 5
    try {$status=(& $pterm status $config.H3Ref --probe | ConvertFrom-Json);if($status.ready){return}}catch{}
  }
  throw 'MiniMax H3 wurde nicht innerhalb von fuenf Minuten bereit.'
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
function Invoke-ZImage([string]$Prompt,[string]$Prefix,[int]$Seed,[int]$Steps=12) {
  Ensure-Comfy
  $env:COMFY_URL=$config.ComfyUrl
  try {
    $clientOutput=& python $imageClient $Prompt --negativ 'contact sheet, storyboard grid, collage, split screen, multiple panels, model sheet, turnaround sheet, white background, text, caption, watermark, logo, malformed anatomy, duplicate people, extra limbs, flat lighting, open door on a moving vehicle, laptop outside a vehicle, physically impossible vehicle, floating objects' --breite 768 --hoehe 448 --schritte $Steps --seed $Seed --name $Prefix 2>&1
    $clientExit=$LASTEXITCODE
    $clientOutput|ForEach-Object { Write-Host $_ }
  } finally { Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue }
  if($clientExit -ne 0){throw "ComfyUI wurde mit Code $clientExit beendet."}
  $folder=Split-Path $Prefix -Parent
  $leaf=Split-Path $Prefix -Leaf
  $result=Get-ChildItem -LiteralPath (Join-Path $comfyOutputRoot $folder) -Filter "$leaf*.png"|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw "ComfyUI meldete Erfolg, aber $leaf wurde nicht gefunden."}
  return $result.FullName
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
  $env:COMFY_URL=$config.ComfyUrl
  & python $imageClient $payload.prompt --negativ 'text, caption, watermark, malformed anatomy, duplicate people, white background, flat lighting' --breite 768 --hoehe 432 --schritte $photoSteps --seed (100000+[int]$job.id) --name $prefix
  Remove-Item Env:COMFY_URL -ErrorAction SilentlyContinue
  if($LASTEXITCODE -ne 0){throw "ComfyUI wurde mit Code $LASTEXITCODE beendet."}
  $result=Get-ChildItem -LiteralPath (Join-Path $comfyOutputRoot 'framecut') -Filter ("job-{0}*.png" -f $job.id)|Sort-Object LastWriteTime -Descending|Select-Object -First 1
  if(-not $result){throw 'ComfyUI meldete Erfolg, aber das Vorschaubild wurde nicht gefunden.'}
  $encoded=[Convert]::ToBase64String([IO.File]::ReadAllBytes($result.FullName))
  $body=@{data="data:image/png;base64,$encoded"}|ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/image" -Headers (Headers) -ContentType 'application/json' -Body $body | Out-Null
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
  # 2>&1 must never be used here: under $ErrorActionPreference='Stop', PowerShell 5.1 wraps
  # every merged stderr line from a native command in a terminating ErrorRecord - so a harmless
  # library warning (e.g. the HuggingFace "no HF_TOKEN" notice) killed the call before the real
  # caption text was ever read, and any genuine Python traceback was silently lost with it.
  $stderrFile=Join-Path $jobRoot 'caption-stderr.log'
  $caption=((& $comfyPythonExe $captionClient $localImage 2>$stderrFile)|Out-String).Trim()
  $exitCode=$LASTEXITCODE
  $stderrText=if(Test-Path -LiteralPath $stderrFile){(Get-Content -LiteralPath $stderrFile -Raw).Trim()}else{''}
  if($exitCode -ne 0){throw "Beschreibung fehlgeschlagen (Code $exitCode): $stderrText"}
  if(-not $caption){throw "Die KI hat keine Beschreibung zurueckgegeben. $stderrText"}
  $body=@{text=$caption}|ConvertTo-Json -Compress
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/caption" -Headers (Headers) -ContentType 'application/json' -Body $body | Out-Null
  Write-Host ("Beschreibung gespeichert: {0}" -f $asset.name) -ForegroundColor Green
}
function Process-Job($payload) {
  $job=$payload.job; $shot=$payload.shot
  Write-Host ("Job {0}: {1} / {2} / Shot {3:00} - {4}" -f $job.id,$job.project_title,$job.episode_title,$shot.sequence,$shot.title) -ForegroundColor Green
  if(-not $shot.prompt){throw 'Dieser Shot hat keinen Video-Prompt.'}
  Free-Models $config.ComfyUrl
  $jobRoot=Join-Path $runtimeRoot ("jobs\{0}" -f $job.id);New-Item -ItemType Directory -Force -Path $jobRoot|Out-Null
  $allRefs=@($shot.references|Where-Object {$_.role -ne 'style'})
  # Assets linked to this shot in the database are a deliberate choice. Prefer the ones the
  # prompt also names, but never drop a linked reference just because the prompt phrased it
  # differently ("the narrator" instead of "Michel") - that silently broke character
  # consistency whenever the wording did not match the asset name exactly.
  $keyframeRefs=@($allRefs|Sort-Object @{Expression={if($shot.prompt -match [regex]::Escape($_.name)){0}else{1}}},@{Expression={[int]$_.id}}|Select-Object -First 3)
  # Characters AND distinctive props (the Tesla, a laptop, a jacket) both need their real
  # photo handed to the renderer - otherwise the model invents a different car every shot.
  # Locations are environment rather than identity, so they stay out of the reference set.
  $identityRefs=@($keyframeRefs|Where-Object {$_.kind -eq 'character' -or $_.kind -eq 'prop'}|Select-Object -First 3)
  $assetText=if ($keyframeRefs.Count -gt 0) { ($keyframeRefs|ForEach-Object {"$($_.name): $($_.visual_notes)"}) -join ' | ' } else { 'None' }
  $keyframePrompt=("SINGLE FULL-BLEED CINEMATIC FRAME, one continuous image, not a storyboard, not a collage. Opening instant of this exact shot: {0}. Camera: {1}. Continuity metadata only (do not visualize biography, occupations or props unless the shot action explicitly asks for them): {2}. Show only the subjects and objects required by the stated action. Everything must be physically plausible. Exterior views of a moving car show a completely closed body and closed doors; occupants stay hidden behind glass unless the shot explicitly requests an interior or person close-up. Project style: {3}. 16:9 widescreen composition, cinematic depth, realistic coherent anatomy, no visible writing, no subtitles, no border, no reference layout." -f $shot.prompt,$shot.camera,$assetText,$job.style_profile).Replace("`r",' ').Replace("`n",' ')
  $approvedKeyframe=Join-Path $runtimeRoot ("approved-keyframes\shot-{0}.png" -f [int]$shot.id)
  $photoSteps=if($job.photo_steps){[int]$job.photo_steps}else{8}
  if(Test-Path -LiteralPath $approvedKeyframe){
    Write-Host ("Geprueften Keyframe wiederverwenden: {0}" -f $approvedKeyframe) -ForegroundColor Cyan
    $sceneKeyframe=$approvedKeyframe
  } else {
    $sceneKeyframe=Invoke-ZImage $keyframePrompt ("framecut-v2/scene-job-{0}" -f [int]$job.id) ([int]$shot.seed) $photoSteps
  }
  Copy-Item -LiteralPath $sceneKeyframe -Destination (Join-Path $jobRoot 'scene-keyframe.png') -Force
  $cleanRefs=@()
  foreach($item in $identityRefs){
    $localRef=Join-Path $jobRoot ("identity-{0}" -f [int]$item.id)
    Invoke-WebRequest -Uri ($config.ServerUrl+$item.downloadUrl) -Headers (Headers) -OutFile $localRef
    $cleanRefs+=$localRef
  }
  Free-Models $config.ComfyUrl
  Stop-OwnedComfy
  Ensure-H3
  $promptFile=Join-Path $jobRoot 'prompt.txt'
  $conditioning='The supplied first frame is the exact full-screen composition and opening moment.'
  $identityNote=if($cleanRefs.Count -gt 0){' The additional reference images define the exact appearance of the named people and objects - match them precisely and do not invent different faces, hair, clothing or vehicles.'}else{''}
  $fullPrompt=("{0}{1} {2} Camera: {3}. One continuous unbroken shot, no edit, no cut, no sudden viewpoint change, never add an unrequested person. Project style: {4}. The audio track is discarded after rendering, so audio content does not matter." -f $conditioning,$identityNote,$shot.prompt,$shot.camera,$job.style_profile)
  Set-Content -LiteralPath $promptFile -Value $fullPrompt -Encoding utf8
  $outputDir=Join-Path $runtimeRoot ("outputs-v2\project-{0}\episode-{1}" -f $job.project_id,$job.episode_number);New-Item -ItemType Directory -Force -Path $outputDir|Out-Null
  $frames=5+(17*[Math]::Max(1,[Math]::Round(([Math]::Min(15,[double]$shot.duration_seconds)*24-5)/17)))
  $name=("shot-{0:d3}-job-{1}" -f [int]$shot.sequence,[int]$job.id)
  $isPreview = $shot.render_tier -eq 'Vorschau'
  $renderWidth = if ($isPreview) { if($job.preview_width){[int]$job.preview_width}else{384} } else { if($job.final_width){[int]$job.final_width}else{768} }
  $renderHeight = if ($isPreview) { if($job.preview_height){[int]$job.preview_height}else{224} } else { if($job.final_height){[int]$job.final_height}else{448} }
  $videoSteps = if($job.video_steps){[int]$job.video_steps}else{4}
  Write-Host ("Qualitaet: {0} ({1}x{2}, {3} Steps)" -f $shot.render_tier,$renderWidth,$renderHeight,$videoSteps) -ForegroundColor DarkCyan
  $renderArgs=@($renderClient,'--base-url',$config.H3Url,'--image',(Join-Path $jobRoot 'scene-keyframe.png'),'--prompt-file',$promptFile,'--output-dir',$outputDir,'--name',$name,'--width',[string]$renderWidth,'--height',[string]$renderHeight,'--frames',[string]$frames,'--steps',[string]$videoSteps,'--seed',[string]([int]$shot.seed),'--low-vram')
  # Hand the linked character/prop photos to the model. Without these the renderer only ever
  # saw the text prompt, which is why faces and vehicles drifted between shots.
  foreach($refPath in $cleanRefs){ $renderArgs += @('--reference-image',$refPath) }
  if($cleanRefs.Count -gt 0){ Write-Host ("Referenzbilder: {0}" -f $cleanRefs.Count) -ForegroundColor DarkCyan }
  & python @renderArgs
  if($LASTEXITCODE -ne 0){throw "MiniMax H3 wurde mit Code $LASTEXITCODE beendet."}
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
  Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/$($job.id)/video" -Headers (Headers) -ContentType 'video/mp4' -InFile $result.FullName | Out-Null
  Write-Host ("Fertig: {0}" -f $result.FullName) -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$transcriptStarted=$false
try { Start-Transcript -LiteralPath (Join-Path $runtimeRoot 'worker.log') -Append | Out-Null; $transcriptStarted=$true } catch {}
# Two workers would fight over the same jobs and the same GPU, so refuse to start a
# second instance while a previous one is still alive.
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
    try {
      $payload=Invoke-RestMethod -Method Get -Uri "$($config.ServerUrl)/api/worker/next" -Headers (Headers)
      if($payload){try{if($payload.job.kind -eq 'comfyui_reference_preview'){Process-ImageJob $payload}elseif($payload.job.kind -eq 'caption_asset'){Process-CaptionJob $payload}else{Process-Job $payload}}catch{Write-Host $_.Exception.Message -ForegroundColor Red;Report-Job $payload.job.id 'fail' $_.Exception.Message}}
    } catch {Write-Host ("Verbindung wartet: {0}" -f $_.Exception.Message) -ForegroundColor DarkYellow}
    if(-not $Once){for($i=0;$i -lt 10 -and -not (Test-Path -LiteralPath $stopPath);$i++){Start-Sleep -Seconds 1}}
  } while(-not $Once)
} finally {
  Stop-OwnedComfy
  Set-Awake $false
  Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
  Write-Host 'FrameCut Worker wurde sauber beendet. Normaler Energiesparmodus ist wieder aktiv.' -ForegroundColor Gray
  if($transcriptStarted){try{Stop-Transcript|Out-Null}catch{}}
}
