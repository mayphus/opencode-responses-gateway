$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$startupFolder = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupFolder "OpenCode Responses Gateway.lnk"
$powerShellPath = Join-Path $PSHOME "powershell.exe"
$startScript = Join-Path $PSScriptRoot "start.ps1"

if (-not (Test-Path -LiteralPath (Join-Path $packageRoot ".opencode-key"))) {
  throw "Run setup-gateway.cmd before installing startup."
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powerShellPath
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`""
$shortcut.WorkingDirectory = $packageRoot
$shortcut.Description = "Start the local OpenCode Responses Gateway"
$shortcut.Save()

Write-Host "Installed for this Windows user:" -ForegroundColor Green
Write-Host $shortcutPath
Write-Host "The gateway will start automatically at the next sign-in."
Read-Host "Press Enter to close"
