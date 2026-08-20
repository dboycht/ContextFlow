param(
  [ValidateSet("electron", "node")]
  [string]$Target = "electron"
)

# 一键切换 better-sqlite3 预编译二进制（ABI）：
#   - Target=electron : 给 VS Code 扩展宿主（F5 调试）用，ABI 146
#   - Target=node     : 给系统 Node（npm test）用，ABI 137
# 从 better-sqlite3 官方 GitHub Release 下载对应 prebuild，覆盖 build/Release/。
# 背景见 DEVELOPMENT.md 排坑记录「better-sqlite3 ABI 不匹配」。

$ErrorActionPreference = "Stop"
$moduleDir = Join-Path $PSScriptRoot "..\node_modules\better-sqlite3"
$releaseDir = Join-Path $moduleDir "build\Release"
$version = "12.11.1"

if ($Target -eq "electron") {
  $runtime = "electron"
  $abi = "146"
} else {
  $runtime = "node"
  $abi = "137"
}

$asset = "better-sqlite3-v$version-$runtime-v$abi-win32-x64.tar.gz"
$url = "https://github.com/WiseLibs/better-sqlite3/releases/download/v$version/$asset"
$tmp = Join-Path $env:TEMP $asset

Write-Host "[switch-sqlite] target: $runtime (ABI $abi)"
if (-not (Test-Path $tmp)) {
  Write-Host "[switch-sqlite] downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} else {
  Write-Host "[switch-sqlite] using cached $tmp"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
tar -xzf $tmp -C $moduleDir
$node = Join-Path $releaseDir "better_sqlite3.node"
if (Test-Path $node) {
  Write-Host "[switch-sqlite] done: $node"
} else {
  Write-Host "[switch-sqlite] WARNING: $node not found, unexpected tarball layout" -ForegroundColor Yellow
}
