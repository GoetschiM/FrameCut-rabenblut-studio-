$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$config=Get-Content -LiteralPath (Join-Path $root 'data\worker.config.json') -Raw|ConvertFrom-Json
$encrypted=(Get-Content -LiteralPath (Join-Path $root 'data\worker-token.dpapi') -Raw).Trim()
$secure=ConvertTo-SecureString $encrypted
$token=[System.Net.NetworkCredential]::new('',$secure).Password
$clip=Join-Path $root 'data\outputs\project-2\episode-1\shot-001-job-2.mp4'
Invoke-RestMethod -Method Post -Uri "$($config.ServerUrl)/api/worker/jobs/2/video" -Headers @{'x-framecut-worker'=$token;'x-framecut-worker-id'=$config.WorkerId} -ContentType 'video/mp4' -InFile $clip
