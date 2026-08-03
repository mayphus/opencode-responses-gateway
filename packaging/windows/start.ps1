$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$keyPath = Join-Path $packageRoot ".opencode-key"
$settingsPath = Join-Path $packageRoot "gateway-settings.json"
$nodePath = Join-Path $packageRoot "node.exe"
$serverPath = Join-Path $packageRoot "src\server.ts"

if (-not (Test-Path -LiteralPath $keyPath) -or -not (Test-Path -LiteralPath $settingsPath)) {
  Write-Host "Run setup-gateway.cmd first." -ForegroundColor Yellow
  Read-Host "Press Enter to close"
  exit 1
}

$secureKey = Get-Content -LiteralPath $keyPath -Raw | ConvertTo-SecureString
$credential = [PSCredential]::new("opencode", $secureKey)
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json

$env:OPENCODE_API_KEY = $credential.GetNetworkCredential().Password
$env:OPENCODE_CHAT_COMPLETIONS_URL = [string]$settings.upstreamUrl
$env:HOST = [string]$settings.host
$env:PORT = [string]$settings.port

Write-Host "Starting the gateway at http://$($env:HOST):$($env:PORT)" -ForegroundColor Cyan
Write-Host "Keep this window open while using ChatGPT Desktop."
try {
  & $nodePath --experimental-strip-types $serverPath
} finally {
  Remove-Item Env:OPENCODE_API_KEY -ErrorAction SilentlyContinue
}
