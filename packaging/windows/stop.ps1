$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $packageRoot "src\server.ts"
$stopped = 0

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | ForEach-Object {
  if ($_.CommandLine -and $_.CommandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null
    $stopped++
  }
}

if ($stopped -gt 0) {
  Write-Host "Stopped $stopped gateway process(es)." -ForegroundColor Green
} else {
  Write-Host "The local gateway is not running."
}
