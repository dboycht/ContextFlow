param(
  [ValidateSet("electron", "node")]
  [string]$Target = "electron"
)

# Unified native ABI switch (better-sqlite3 + node-pty):
#   Target=electron : VS Code extension host (F5), Electron 42.8.0 (ABI 146)
#   Target=node     : system Node (npm test), ABI 137
# better-sqlite3: official GitHub prebuilds (switch-sqlite.ps1).
# node-pty: official package uses prebuildify (prebuilds/win32-x64/);
#   node build = official prebuild, electron build = locally compiled
#   from build/Release (see DEVELOPMENT.md pitfalls).

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$pty = Join-Path $root "node_modules\node-pty\prebuilds\win32-x64"
$ptyNode = "$pty-node"
$ptyElectron = "$pty-electron"

# first-time backups
if (-not (Test-Path $ptyNode) -and (Test-Path $pty)) {
  Write-Host "[switch-native] backup node-pty node build -> prebuilds/win32-x64-node"
  Copy-Item $pty $ptyNode -Recurse -Force
}
if (-not (Test-Path $ptyElectron)) {
  Write-Host "[switch-native] backup node-pty electron build -> prebuilds/win32-x64-electron (from build/Release)"
  New-Item -ItemType Directory -Path $ptyElectron -Force | Out-Null
  $rel = Join-Path $root "node_modules\node-pty\build\Release"
  Copy-Item "$rel\pty.node", "$rel\conpty.node", "$rel\conpty_console_list.node", "$rel\winpty.dll", "$rel\winpty-agent.exe" $ptyElectron -Force
  if (Test-Path "$pty\conpty") { Copy-Item "$pty\conpty" $ptyElectron -Recurse -Force }
}

# switch node-pty
if (Test-Path $pty) { Remove-Item $pty -Recurse -Force }
if ($Target -eq "electron") {
  Copy-Item $ptyElectron $pty -Recurse -Force
} else {
  Copy-Item $ptyNode $pty -Recurse -Force
}
Write-Host "[switch-native] node-pty -> $Target"

# switch better-sqlite3 (reuse switch-sqlite.ps1)
& (Join-Path $PSScriptRoot "switch-sqlite.ps1") -Target $Target
Write-Host "[switch-native] done ($Target)"
