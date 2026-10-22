<#
  Registers the native-messaging host for Chrome, Edge and Brave for the current user (no admin needed).
  Writes a launcher .cmd and a manifest into the install folder, then adds the HKCU registry keys.
  Usage: .\install-native-host.ps1 [-Uninstall]
#>
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$name = 'com.downloadmanager.host'
$extId = (Get-Content "$root\apps\extension\extension-id.txt").Trim()
$outDir = Join-Path $env:LOCALAPPDATA 'DownloadManager\native-host'
$keys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$name",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$name",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$name"
)

if ($Uninstall) {
  foreach ($k in $keys) { if (Test-Path $k) { Remove-Item $k -Recurse -Force } }
  if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
  'Native host unregistered.'
  return
}

$bundle = "$root\apps\native-host\dist\native-host.cjs"
if (-not (Test-Path $bundle)) { throw "Build it first: npm run build --workspace @dm/native-host" }
$node = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force $outDir | Out-Null
Copy-Item $bundle "$outDir\native-host.cjs" -Force
Set-Content "$outDir\launch.cmd" -Encoding ascii -Value "@echo off`r`n`"$node`" `"%~dp0native-host.cjs`""

$manifest = [ordered]@{
  name = $name
  description = 'Download Manager browser integration'
  path = "$outDir\launch.cmd"
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extId/")
}
$manifestPath = "$outDir\$name.json"
$manifest | ConvertTo-Json | Set-Content $manifestPath -Encoding ascii

foreach ($k in $keys) {
  New-Item -Path $k -Force | Out-Null
  Set-ItemProperty -Path $k -Name '(default)' -Value $manifestPath
}
"Registered for Chrome, Edge and Brave. Extension ID: $extId"
"Now load apps\extension as an unpacked extension (chrome://extensions, Developer mode)."
