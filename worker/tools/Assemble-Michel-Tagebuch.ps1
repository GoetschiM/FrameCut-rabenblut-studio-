$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime=Join-Path $root 'data'
Add-Type -AssemblyName System.Security
$config=Get-Content -LiteralPath (Join-Path $runtime 'worker.config.json') -Raw|ConvertFrom-Json
$hex=(Get-Content -LiteralPath (Join-Path $runtime 'worker-token.dpapi') -Raw).Trim()
$bytes=New-Object byte[] ($hex.Length/2)
for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
$token=[Text.Encoding]::Unicode.GetString($plain)
$headers=@{'x-framecut-worker'=$token;'x-framecut-worker-id'=$config.WorkerId}
$outputDir=Join-Path $runtime 'outputs\project-2\episode-1'
$final=Join-Path $outputDir 'Michel-Tagebuch-Rohschnitt-4m28s.mp4'
$manifest=Join-Path $outputDir 'concat.txt'
$log=Join-Path $runtime 'assembly.log'
$ffmpeg='C:\Users\Miche\Documents\Pinokio\bin\miniconda\Library\bin\ffmpeg.exe'

New-Item -ItemType Directory -Force -Path $outputDir|Out-Null
"$(Get-Date -Format o) Warte auf 51 Clips."|Set-Content -LiteralPath $log -Encoding utf8
while($true){
  try{$status=Invoke-RestMethod -Uri "$($config.ServerUrl)/api/worker/episodes/2/status" -Headers $headers}catch{"$(Get-Date -Format o) Server voruebergehend nicht erreichbar."|Add-Content -LiteralPath $log -Encoding utf8;Start-Sleep -Seconds 30;continue}
  $failed=@($status.counts|Where-Object state -eq 'fehlgeschlagen'|Measure-Object count -Sum).Sum
  if($failed -gt 0){throw "$failed Render-Auftraege sind fehlgeschlagen. Vor dem Schnitt ist eine Korrektur noetig."}
  if([int]$status.shots.finished -ge 51){break}
  "$(Get-Date -Format o) $($status.shots.finished)/51 Clips online."|Add-Content -LiteralPath $log -Encoding utf8
  Start-Sleep -Seconds 30
}
$clips=Get-ChildItem -LiteralPath $outputDir -Filter 'shot-*-job-*.mp4'|Sort-Object Name
if($clips.Count -ne 51){throw "Online sind 51 Clips fertig, lokal wurden aber nur $($clips.Count) Dateien gefunden."}
$clips|ForEach-Object{"file '$($_.FullName.Replace('\','/'))'"}|Set-Content -LiteralPath $manifest -Encoding ascii
& $ffmpeg -y -f concat -safe 0 -i $manifest -c copy -movflags +faststart $final
if($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $final)){throw 'FFmpeg konnte den Rohschnitt nicht erstellen.'}
& curl.exe --fail --silent --show-error -X POST -H "x-framecut-worker: $token" -H "x-framecut-worker-id: $($config.WorkerId)" -H 'x-framecut-name: Michel-Tagebuch-Rohschnitt-4m28s.mp4' -H 'content-type: video/mp4' --data-binary "@$final" "$($config.ServerUrl)/api/worker/episodes/2/final" | Out-Null
if($LASTEXITCODE -ne 0){throw 'Der fertige Rohschnitt konnte nicht zum FrameCut-Server hochgeladen werden.'}
"$(Get-Date -Format o) Fertig: $final"|Add-Content -LiteralPath $log -Encoding utf8
