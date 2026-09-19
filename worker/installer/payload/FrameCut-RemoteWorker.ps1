[CmdletBinding()]
param([switch]$Once)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $env:ProgramData 'FrameCut\Worker\worker.json'

function Unprotect-Token([string]$ProtectedToken) {
    Add-Type -AssemblyName System.Security
    $raw = [Convert]::FromBase64String($ProtectedToken)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
    [Text.Encoding]::UTF8.GetString($plain)
}
function Send-Heartbeat($config, $token) {
    $headers = @{ 'x-framecut-worker'=$token; 'x-framecut-worker-id'=[string]$config.workerId }
    $payload = @{ status='awaiting_runtime'; version=[string]$config.version } | ConvertTo-Json -Compress
    Invoke-RestMethod -Uri ("{0}/api/worker/heartbeat" -f $config.serverUrl.TrimEnd('/')) -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 20 | Out-Null
}

if (-not (Test-Path -LiteralPath $configPath)) { throw "FrameCut-Konfiguration fehlt: $configPath" }
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$token = Unprotect-Token ([string]$config.workerTokenProtected)

do {
    try { Send-Heartbeat $config $token } catch { Write-Warning "FrameCut Bootstrap-Heartbeat fehlgeschlagen: $($_.Exception.Message)" }
    if (-not $Once) { Start-Sleep -Seconds 45 }
} while (-not $Once)
