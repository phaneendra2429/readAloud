param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId,

  [Parameter(Mandatory = $false)]
  [string]$PythonExe = "",

  [Parameter(Mandatory = $false)]
  [string]$InstallDir = "",

  [Parameter(Mandatory = $false)]
  [string]$ApiUrl = "http://127.0.0.1:8765/v1/synthesize_stream",

  [Parameter(Mandatory = $false)]
  [ValidateSet("Chrome", "Edge", "Brave", "All")]
  [string]$Browsers = "All"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$NativeSrc = Join-Path $RepoRoot "native-host"

if (-not $InstallDir) {
  $InstallDir = Join-Path $env:LOCALAPPDATA "PiperReadAloudNativeHost"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

Copy-Item -Force (Join-Path $NativeSrc "bridge.py") (Join-Path $InstallDir "bridge.py")

if (-not $PythonExe) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "python was not found on PATH. Install Python 3.12+ or pass -PythonExe."
  }
  $PythonExe = $cmd.Source
}

$BridgeBat = @"
@echo off
cd /d "$InstallDir"
set PYTHONUTF8=1
set PIPER_API_URL=$ApiUrl
"$PythonExe" bridge.py
"@

Set-Content -Path (Join-Path $InstallDir "bridge.bat") -Value $BridgeBat -Encoding ASCII

$LauncherPath = Join-Path $InstallDir "bridge.bat"
if (-not (Test-Path $LauncherPath)) {
  throw "Failed to write launcher at $LauncherPath"
}

$Origin = "chrome-extension://$ExtensionId/"
$ManifestPath = Join-Path $InstallDir "com.piper.reader.json"

$manifest = [ordered]@{
  name                = "com.piper.reader"
  description         = "HTTP bridge for Piper Read-Aloud Chrome extension"
  path                = $LauncherPath.Replace("/", "\\")
  type                = "stdio"
  allowed_origins     = @($Origin)
}

$manifestJson = $manifest | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ManifestPath, $manifestJson, $utf8NoBom)

$targets = switch ($Browsers) {
  "All" { @("Chrome", "Edge", "Brave") }
  default { @($Browsers) }
}

$regPaths = @{
  Chrome = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.piper.reader"
  Edge   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.piper.reader"
  Brave  = "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.piper.reader"
}

foreach ($b in $targets) {
  $RegPath = $regPaths[$b]
  if (-not $RegPath) {
    continue
  }
  New-Item -Path $RegPath -Force | Out-Null
  Set-ItemProperty -LiteralPath $RegPath -Name '(Default)' -Value $ManifestPath
  Write-Host "Registered native host for ${b}:"
  Write-Host "  $RegPath"
}

Write-Host ""
Write-Host "Installed native host manifest:"
Write-Host "  $ManifestPath"
Write-Host "Launcher:"
Write-Host "  $LauncherPath"
Write-Host "Allowed origin:"
Write-Host "  $Origin"
Write-Host ""
Write-Host "Restart every browser you registered (Chrome / Edge / Brave) after changing the extension ID or this install."
