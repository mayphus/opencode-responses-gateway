$ErrorActionPreference = "Stop"
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "OpenCode Responses Gateway.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host "Removed the gateway from Windows Startup." -ForegroundColor Green
} else {
  Write-Host "The gateway is not installed in Windows Startup."
}
Read-Host "Press Enter to close"
