[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repo = Split-Path $PSScriptRoot -Parent
$root = Join-Path $repo 'worker'
$version = (Get-Content -LiteralPath (Join-Path $root 'worker.version.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d{4}\.\d{2}\.\d{2}\.\d+$') { throw 'Invalid worker release version.' }
$releases = Join-Path $root 'releases'
$output = Join-Path $releases "framecut-worker-$version.zip"
if (Test-Path -LiteralPath $output) { throw "Release already exists; use a new version: $version" }
$stage = Join-Path ([IO.Path]::GetTempPath()) ('framecut-release-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  # Explicitly tracked files only: never ship data, DPAPI tokens, logs or backups.
  $files = & git -C $repo ls-files worker
  if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate tracked worker files.' }
  $files = @($files | Where-Object { $_ -match '^worker/(adapters/.*\.py|framecut_[^/]+\.py|FrameCut-[^/]+\.(ps1|bat)|worker\.version\.json)$' })
  foreach ($file in $files) {
    $relative = $file.Substring(7)
    $destination = Join-Path $stage $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo $file) -Destination $destination
  }
  foreach ($name in @('FrameCut-RuntimeSetup.ps1','FrameCut-RemoteWorker.ps1','Start-FrameCutRemoteWorker.bat')) {
    Copy-Item -LiteralPath (Join-Path $root "installer/payload/$name") -Destination (Join-Path $stage $name)
  }
  foreach ($script in Get-ChildItem -LiteralPath $stage -Filter '*.ps1' -Recurse) {
    # Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI. Normalize packaged
    # copies only, preserving user settings and the source working tree.
    $source = [IO.File]::ReadAllText($script.FullName,[Text.Encoding]::UTF8)
    [IO.File]::WriteAllText($script.FullName,$source,[Text.UTF8Encoding]::new($true))
    $parseTokens=$null; $parseErrors=$null
    [void][Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$parseTokens,[ref]$parseErrors)
    if ($parseErrors.Count) { throw "Invalid PowerShell: $($script.Name): $parseErrors" }
  }
  [IO.Compression.ZipFile]::CreateFromDirectory($stage,$output)
  $hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
  $previous = Get-Content -LiteralPath (Join-Path $releases 'current.json') -Raw | ConvertFrom-Json
  $manifest = @{version=$version;file=[IO.Path]::GetFileName($output);installerFile=$previous.installerFile;sha256=$hash;entrypoint='FrameCut-Worker.bat'}
  # Build output, not source editing. Publish this manifest last, after its ZIP.
  [IO.File]::WriteAllText((Join-Path $releases 'current.json'),($manifest | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Output ($manifest | ConvertTo-Json)
} finally {
  $resolved = [IO.Path]::GetFullPath($stage)
  $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('framecut-release-')) {
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
