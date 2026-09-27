[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$WorkerRoot,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security

function Read-WorkerToken([string]$Path) {
  $hex=(Get-Content -LiteralPath $Path -Raw).Trim()
  if(-not $hex -or $hex.Length % 2){throw 'Worker-Token ist ungültig.'}
  $bytes=New-Object byte[] ($hex.Length/2)
  for($i=0;$i -lt $bytes.Length;$i++){$bytes[$i]=[Convert]::ToByte($hex.Substring($i*2,2),16)}
  $plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  return [Text.Encoding]::Unicode.GetString($plain)
}
function Get-Sha256([string]$Path) {
  $stream=[IO.File]::OpenRead($Path)
  try {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

$data=Join-Path $WorkerRoot 'data'
$configPath=Join-Path $data 'worker.config.json'
$tokenPath=Join-Path $data 'worker-token.dpapi'
$logPath=Join-Path $data 'worker-update.log'
function Log([string]$Message) {
  $line="$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

try {
  if($ParentPid -gt 0){
    $deadline=(Get-Date).AddMinutes(3)
    while(Get-Process -Id $ParentPid -ErrorAction SilentlyContinue){
      if((Get-Date) -gt $deadline){throw 'Der bisherige Worker wurde nicht rechtzeitig beendet.'}
      Start-Sleep -Seconds 1
    }
  }
  $config=Get-Content -LiteralPath $configPath -Raw|ConvertFrom-Json
  $manifest=Invoke-RestMethod -Method Get -Uri "$($ServerUrl.TrimEnd('/'))/api/worker/installer/manifest" -TimeoutSec 20
  if(-not $manifest.version -or -not $manifest.downloadUrl -or -not $manifest.sha256 -or -not $manifest.entrypoint){throw 'Server-Update-Manifest ist unvollständig.'}
  $updateRoot=Join-Path $data 'updates'
  $stage=Join-Path $updateRoot ("stage-"+[guid]::NewGuid().ToString('N'))
  $archive=Join-Path $updateRoot ("worker-"+[guid]::NewGuid().ToString('N')+'.zip')
  New-Item -ItemType Directory -Force -Path $stage|Out-Null
  New-Item -ItemType Directory -Force -Path $updateRoot|Out-Null
  try {
    $headers=@{'x-framecut-worker'=Read-WorkerToken $tokenPath;'x-framecut-worker-id'=[string]$config.WorkerId}
    Invoke-WebRequest -Uri ([string]$manifest.downloadUrl) -Headers $headers -OutFile $archive -UseBasicParsing -TimeoutSec 180
    if((Get-Sha256 $archive) -ne ([string]$manifest.sha256).ToLowerInvariant()){throw 'Worker-Update wurde wegen einer fehlerhaften SHA-256-Prüfsumme verworfen.'}
    Expand-Archive -LiteralPath $archive -DestinationPath $stage -Force
    $required=@('FrameCut-Worker.ps1','FrameCut-Worker.bat','FrameCut-Worker-Update.ps1','worker.version.json',[string]$manifest.entrypoint)
    foreach($file in $required){if(-not(Test-Path -LiteralPath (Join-Path $stage $file))){throw "Worker-Update enthält '$file' nicht."}}
    # Copy files by relative path. Copying the adapters directory into an existing
    # adapters directory creates adapters/adapters on Windows and leaves old code active.
    $stagePrefix=[IO.Path]::GetFullPath($stage).TrimEnd('\')+'\'
    $rootPrefix=[IO.Path]::GetFullPath($WorkerRoot).TrimEnd('\')+'\'
    $backup=Join-Path $updateRoot ('backup-'+[guid]::NewGuid().ToString('N'))
    $installed=@()
    try {
      foreach($file in Get-ChildItem -LiteralPath $stage -File -Recurse -Force){
        $relative=$file.FullName.Substring($stagePrefix.Length)
        if($relative -match '^data[\\/]'){continue}
        $target=[IO.Path]::GetFullPath((Join-Path $WorkerRoot $relative))
        if(-not $target.StartsWith($rootPrefix,[StringComparison]::OrdinalIgnoreCase)){throw 'Ungültiger Pfad im Worker-Update.'}
        $saved=Join-Path $backup $relative
        $existed=Test-Path -LiteralPath $target
        if($existed){New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent)|Out-Null;Copy-Item -LiteralPath $target -Destination $saved}
        $installed+=@{Target=$target;Saved=$saved;Existed=$existed}
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent)|Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
      }
    } catch {
      foreach($file in $installed){
        if($file.Existed){Copy-Item -LiteralPath $file.Saved -Destination $file.Target -Force}
        elseif(Test-Path -LiteralPath $file.Target){Remove-Item -LiteralPath $file.Target -Force}
      }
      throw
    }
    Log "Update auf Version $($manifest.version) installiert."
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    $resolvedStage=[IO.Path]::GetFullPath($stage)
    $resolvedUpdates=[IO.Path]::GetFullPath($updateRoot).TrimEnd('\')+'\'
    if($resolvedStage.StartsWith($resolvedUpdates,[StringComparison]::OrdinalIgnoreCase)){
      Remove-Item -LiteralPath $resolvedStage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $entry=Join-Path $WorkerRoot ([string]$manifest.entrypoint)
  Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c',('"'+$entry+'"')) -WorkingDirectory $WorkerRoot -WindowStyle Hidden
} catch {
  try { Log "Update fehlgeschlagen: $($_.Exception.Message)" } catch {}
  # A failed download must not leave a remote render machine permanently offline.
  $fallback=Join-Path $WorkerRoot 'FrameCut-Worker.bat'
  if(Test-Path -LiteralPath $fallback){Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c',('"'+$fallback+'"')) -WorkingDirectory $WorkerRoot -WindowStyle Hidden}
}
