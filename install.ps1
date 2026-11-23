# Cairn CLI installer for Windows PowerShell.
#
#   irm https://raw.githubusercontent.com/Arshdeep-Yadav/Cairn/main/install.ps1 | iex
#
# The npm names "cairn" and "cairn-memory" belong to unrelated packages, so this
# installs straight from the GitHub repository instead.

$ErrorActionPreference = 'Stop'
$Ref = if ($env:CAIRN_REF) { $env:CAIRN_REF } else { 'main' }
$Package = 'cairn-memory'

if ($args -contains '--uninstall' -or $env:CAIRN_UNINSTALL -eq '1') {
  npm uninstall -g $Package 2>$null | Out-Null
  Write-Host 'Cairn CLI removed. Your .cairn/ vault was left untouched.'
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required.' }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required (found $(node -v))." }

$tmp = Join-Path $env:TEMP ("cairn-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  $source = $null

  if (Get-Command git -ErrorAction SilentlyContinue) {
    $source = Join-Path $tmp 'Cairn'
    git clone --quiet --depth 1 --branch $Ref 'https://github.com/Arshdeep-Yadav/Cairn.git' $source
    if ($LASTEXITCODE -ne 0) { throw "Could not clone Cairn (ref: $Ref)." }
  } else {
    $zip = Join-Path $tmp 'cairn.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/Arshdeep-Yadav/Cairn/zip/refs/heads/$Ref" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $source = Get-ChildItem -Path $tmp -Directory -Filter 'Cairn-*' | Select-Object -First 1
    if (-not $source) { throw 'Could not find the extracted Cairn source.' }
    $source = $source.FullName
  }

  if (-not (Test-Path (Join-Path $source 'package.json'))) { throw 'Downloaded source is missing package.json.' }

  Write-Host "Building Cairn from GitHub ($Ref)…"
  Push-Location $source
  npm ci --silent
  if ($LASTEXITCODE -ne 0) { npm install --silent }
  npm run build --silent
  if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
  # Install from a packed tarball. `npm install -g .` links to the source folder
  # on Windows, which breaks when this installer cleans up its temp directory.
  $packed = npm pack --silent
  $tarball = $packed | Where-Object { $_ -like '*.tgz' } | Select-Object -Last 1
  if (-not $tarball -or -not (Test-Path $tarball)) { throw 'npm pack did not produce a tarball.' }
  npm install -g (Join-Path (Get-Location).Path $tarball) --silent
  if ($LASTEXITCODE -ne 0) { throw 'Global install failed.' }
  Pop-Location

  Write-Host ''
  Write-Host 'Cairn installed.'
  cairn --version 2>$null
  Write-Host ''
  Write-Host 'Next: cd into your project and run'
  Write-Host '  cairn start --connect claude-code --git-hooks'
}
finally {
  if ((Get-Location).Path -like "$tmp*") { Pop-Location }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
