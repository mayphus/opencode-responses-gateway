$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$keyPath = Join-Path $packageRoot ".opencode-key"
$settingsPath = Join-Path $packageRoot "gateway-settings.json"

Write-Host "OpenCode Responses Gateway setup" -ForegroundColor Cyan
Write-Host "The API key is encrypted with Windows DPAPI for this Windows user."
$secureKey = Read-Host "Paste the OpenCode API key" -AsSecureString
if ($secureKey.Length -eq 0) {
  throw "The OpenCode API key cannot be empty."
}
$secureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $keyPath -Encoding UTF8

$defaultUrl = "https://opencode.ai/zen/v1/chat/completions"
$upstreamUrl = Read-Host "Chat Completions URL [$defaultUrl]"
if ([string]::IsNullOrWhiteSpace($upstreamUrl)) {
  $upstreamUrl = $defaultUrl
}
if (-not [Uri]::IsWellFormedUriString($upstreamUrl, [UriKind]::Absolute)) {
  throw "The Chat Completions URL is not a valid absolute URL."
}

@{
  upstreamUrl = $upstreamUrl
  host = "127.0.0.1"
  port = 8080
} | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8

if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("OPENAI_API_KEY", "User"))) {
  [Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "local-opencode-gateway", "User")
  Write-Host "Created a harmless OPENAI_API_KEY placeholder for ChatGPT Desktop."
}

Write-Host "Setup complete." -ForegroundColor Green
Write-Host "Fully quit and reopen ChatGPT Desktop after copying config-snippet.toml."
Read-Host "Press Enter to close"
