<#
  Builds a self-contained Windows package in dist\HyperFetchPro:
    DownloadManager.exe + runtime   (dotnet publish, self-contained, no .NET install needed)
    core\node.exe, core\host.mjs    (Node runtime and the bundled engine)
    integration\                    (browser extension, native host, registration script)
  and zips it to dist\HyperFetchPro-win-x64.zip.
  Usage: .\scripts\build-package.ps1 [-Version 0.1.0]
#>
param([string]$Version = '0.1.0')

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$out = Join-Path $root 'dist\HyperFetchPro'
Set-Location $root

Write-Host '1/6 Building the core and the native host'
npm run build --workspace @dm/core-host | Out-Null
npm run build --workspace @dm/native-host | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Core build failed' }

Write-Host '2/6 Publishing the app (self-contained)'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
dotnet publish "$root\apps\windows\DownloadManager\DownloadManager.csproj" -c Release -r win-x64 -p:Platform=x64 `
  --self-contained -p:Version=$Version -o $out | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

Write-Host '3/6 Adding Node and the core'
New-Item -ItemType Directory "$out\core", "$out\integration" | Out-Null
Copy-Item (Get-Command node.exe).Source "$out\core\node.exe"
Copy-Item "$root\apps\core-host\dist\host.mjs" "$out\core\host.mjs"

Write-Host '4/6 Adding browser integration'
Copy-Item "$root\apps\native-host\dist\native-host.cjs" "$out\integration\native-host.cjs"
Copy-Item "$root\scripts\install-native-host.ps1" "$out\integration\install-native-host.ps1"
Copy-Item "$root\apps\extension" "$out\integration\extension" -Recurse
Copy-Item "$root\README.md" "$out\README.md"

Write-Host '5/6 Zipping'
$zip = Join-Path $root 'dist\HyperFetchPro-win-x64.zip'
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path "$out\*" -DestinationPath $zip -CompressionLevel Optimal
$size = '{0:N0} MB' -f ((Get-Item $zip).Length / 1MB)
"Done: $zip ($size)"

Write-Host '6/6 Building the installer (needs Inno Setup 6)'
$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
  & $iscc "/DAppVersion=$Version" /Qp "$root\installer\HyperFetchPro.iss"
  if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
  $setup = Join-Path $root "dist\HyperFetchPro-Setup-$Version.exe"
  "Done: $setup ({0:N0} MB)" -f ((Get-Item $setup).Length / 1MB)
} else {
  'Inno Setup not found; skipped the installer (install it with: winget install JRSoftware.InnoSetup). The zip is still available.'
}
