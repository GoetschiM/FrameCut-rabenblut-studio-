$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime=Join-Path $root 'data'
$config=Get-Content -LiteralPath (Join-Path $runtime 'worker.config.json') -Raw|ConvertFrom-Json
$ffmpeg='C:\Users\Miche\Documents\Pinokio\bin\miniconda\Library\bin\ffmpeg.exe'
$ffprobe='C:\Users\Miche\Documents\Pinokio\bin\miniconda\Library\bin\ffprobe.exe'
$pterm='C:\Users\Miche\Documents\Pinokio\bin\npm\pterm.cmd'
$qwenRef='pinokio://10.0.20.216:42000/api/Qwen3-TTS-Pinokio.git'
$ttsClient=Join-Path (Split-Path -Parent (Split-Path -Parent $root)) 'pinokio_agent\skills\api\Qwen3-TTS-Pinokio.git\clients\generate_michel_tagebuch.py'
$outputDir=Join-Path $runtime 'outputs-v2\project-2\episode-1'
$normalized=Join-Path $outputDir 'normalized'
$audioDir=Join-Path $outputDir 'narration'
$log=Join-Path $runtime 'finish-v2.log'
$pidFile=Join-Path $runtime 'finisher-v2.pid'

Add-Type -AssemblyName System.Security
function Read-Token {
  $hex=(Get-Content -LiteralPath (Join-Path $runtime 'worker-token.dpapi') -Raw).Trim()
  $bytes=New-Object byte[] ($hex.Length/2)
  for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}
  $plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Text.Encoding]::Unicode.GetString($plain)
}
function Log([string]$Text){"$(Get-Date -Format o) $Text"|Add-Content -LiteralPath $log -Encoding utf8}
function Require-Success([string]$Message){if($LASTEXITCODE -ne 0){throw $Message}}
function New-TitleCard([string]$Path,[double]$Duration,[string]$Title,[string]$Subtitle){
  $font='C\:/Windows/Fonts/arialbd.ttf'
  $vf="drawtext=fontfile='$font':text='$Title':fontcolor=white:fontsize=66:x=(w-text_w)/2:y=(h-text_h)/2-40,drawtext=fontfile='$font':text='$Subtitle':fontcolor=0xD23B43:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2+55,fade=t=in:st=0:d=1,fade=t=out:st=$($Duration-1):d=1"
  & $ffmpeg -y -f lavfi -i "color=c=0x05070d:s=1280x720:r=24:d=$Duration" -f lavfi -i 'anullsrc=r=48000:cl=stereo' -t $Duration -vf $vf -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k $Path 2>>$log
  Require-Success "Titelkarte konnte nicht erstellt werden: $Title"
}

Set-Content -LiteralPath $pidFile -Value $PID -Encoding ascii
Set-Content -LiteralPath $log -Value "$(Get-Date -Format o) V2-Finisher wartet auf 51 geprüfte Clips." -Encoding utf8
try {
  while($true){
    try{$status=Invoke-RestMethod -Uri "$($config.ServerUrl)/api/worker/episodes/2/status" -Headers @{'x-framecut-worker'=(Read-Token);'x-framecut-worker-id'=$config.WorkerId}}
    catch{Log 'FrameCut-Server vorübergehend nicht erreichbar.';Start-Sleep -Seconds 60;continue}
    $failed=@($status.counts|Where-Object {$_.state -eq 'fehlgeschlagen'}|Measure-Object count -Sum).Sum
    if([int]$status.shots.finished -ge 51){break}
    Log ("Rendering: {0}/51 Online-Clips; frühere Fehlversuche: {1}." -f $status.shots.finished,$failed)
    Start-Sleep -Seconds 60
  }

  New-Item -ItemType Directory -Force -Path $outputDir,$normalized,$audioDir|Out-Null
  $selected=@()
  for($sequence=1;$sequence -le 51;$sequence++){
    $matches=Get-ChildItem -LiteralPath $outputDir -Filter ("shot-{0:d3}-job-*.mp4" -f $sequence)|Sort-Object {[int]([regex]::Match($_.BaseName,'job-(\d+)$').Groups[1].Value)} -Descending
    if(-not $matches){throw "V2-Clip $sequence fehlt lokal."}
    $selected+=$matches[0]
  }
  Log 'Alle 51 V2-Clips lokal gefunden.'

  $intro=Join-Path $normalized '000-intro.mp4'
  $outro=Join-Path $normalized '052-outro.mp4'
  New-TitleCard $intro 6 'MICHEL TAGEBUCH' 'DER SONNTAG VOR DEN FERIEN'
  foreach($clip in $selected){
    $seq=[int]([regex]::Match($clip.BaseName,'shot-(\d+)').Groups[1].Value)
    $target=Join-Path $normalized ("{0:d3}.mp4" -f $seq)
    if(Test-Path -LiteralPath $target){continue}
    & $ffmpeg -y -i $clip.FullName -vf 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,fps=24' -af 'aresample=48000,apad' -t ([double](& $ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 $clip.FullName)) -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k $target 2>>$log
    Require-Success "Clip $seq konnte nicht normalisiert werden."
  }
  New-TitleCard $outro 8 'MICHEL TAGEBUCH' 'EINE FRAMECUT PRODUKTION'
  $concat=Join-Path $normalized 'concat-v2.txt'
  @($intro)+@(1..51|ForEach-Object {Join-Path $normalized ("{0:d3}.mp4" -f $_)})+@($outro)|ForEach-Object {"file '$($_.Replace('\','/'))'"}|Set-Content -LiteralPath $concat -Encoding ascii
  $nativeMaster=Join-Path $outputDir 'Michel-Tagebuch-V2-Native-Audio.mp4'
  & $ffmpeg -y -f concat -safe 0 -i $concat -c copy -movflags +faststart $nativeMaster 2>>$log
  Require-Success 'Der V2-Rohschnitt konnte nicht erstellt werden.'
  Log 'V2-Rohschnitt mit nativer H3-Atmosphäre fertig.'

  try{Invoke-RestMethod -Method Post -Uri "$($config.H3Url)/free" -ContentType 'application/json' -Body '{"unload_models":true,"free_memory":true}'|Out-Null}catch{}
  $qwen=$null
  try{$qwen=(& $pterm status $qwenRef --probe|ConvertFrom-Json)}catch{}
  if(-not $qwen.ready){& $pterm run $qwenRef|Out-Null}
  for($attempt=0;$attempt -lt 90;$attempt++){
    Start-Sleep -Seconds 2
    try{$qwen=(& $pterm status $qwenRef --probe|ConvertFrom-Json);if($qwen.ready){break}}catch{}
  }
  if(-not $qwen.ready){throw 'Qwen3-TTS wurde nicht bereit.'}
  & python $ttsClient --base-url $qwen.ready_url --output-dir $audioDir 2>>$log
  Require-Success 'Die deutsche Erzählstimme konnte nicht erzeugt werden.'
  Log 'Deutsche Qwen-Erzählstimme fertig.'

  $cues=Get-Content -LiteralPath (Join-Path $audioDir 'narration-cues.json') -Raw|ConvertFrom-Json
  $inputs=@('-i',$nativeMaster)
  foreach($cue in $cues){$inputs+=@('-i',(Join-Path $audioDir $cue.file))}
  $filters=@('[0:a]volume=0.32[bg]')
  $mix=@('[bg]')
  for($i=0;$i -lt $cues.Count;$i++){
    $delay=[int]([double]$cues[$i].start*1000);$limit=[Math]::Max(1,[double]$cues[$i].end-[double]$cues[$i].start)
    $filters+=("[{0}:a]atrim=0:{1},adelay={2}|{2},volume=1.25[n{0}]" -f ($i+1),$limit,$delay)
    $mix+=("[n{0}]" -f ($i+1))
  }
  $filters+=((($mix -join '')+"amix=inputs=$($cues.Count+1):normalize=0:dropout_transition=0,alimiter=limit=0.95[mix]"))
  $subtitle=(Join-Path $audioDir 'Michel-Tagebuch-Deutsch.srt').Replace('\','/').Replace(':','\:')
  $filters+=("[0:v]subtitles=filename='$subtitle':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=34'[video]")
  $final=Join-Path $outputDir 'Michel-Tagebuch-Episode-01-FINAL-HD.mp4'
  & $ffmpeg -y @inputs -filter_complex ($filters -join ';') -map '[video]' -map '[mix]' -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -ar 48000 -movflags +faststart $final 2>>$log
  Require-Success 'Das finale HD-Master konnte nicht erstellt werden.'
  $probe=& $ffprobe -v error -show_entries stream=codec_type,codec_name,channels,sample_rate,width,height -show_entries format=duration,size -of json $final
  $probe|Set-Content -LiteralPath (Join-Path $outputDir 'final-probe.json') -Encoding utf8
  $token=Read-Token
  & curl.exe --fail --silent --show-error -X POST -H "x-framecut-worker: $token" -H "x-framecut-worker-id: $($config.WorkerId)" -H 'x-framecut-name: Michel-Tagebuch-Episode-01-FINAL-HD.mp4' -H 'content-type: video/mp4' --data-binary "@$final" "$($config.ServerUrl)/api/worker/episodes/2/final"|Out-Null
  Require-Success 'Das finale Master konnte nicht zum FrameCut-Server hochgeladen werden.'
  Log "FERTIG: $final"
} catch {Log ("FEHLER: "+$_.Exception.Message);throw} finally {Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue}
