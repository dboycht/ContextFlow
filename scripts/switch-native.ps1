param(
  [ValidateSet("electron", "node")]
  [string]$Target = "electron"
)

# Native ABI switch (better-sqlite3 only):
#   Target=electron : VS Code extension host (F5), Electron 42.8.1 (ABI 146)
#   Target=node     : system Node (npm test), ABI 137
# node-pty is an N-API module (napi_register_module_v1) - cross-ABI compatible,
# no switch needed (official prebuild works in both node and electron).
$ErrorActionPreference = "Stop"
& (Join-Path $PSScriptRoot "switch-sqlite.ps1") -Target $Target
Write-Host "[switch-native] better-sqlite3 -> $Target (node-pty N-API, no switch needed)"
