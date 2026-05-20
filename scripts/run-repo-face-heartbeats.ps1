Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $PSScriptRoot "run-repo-face-heartbeats.ts"
$tsxCliPath = Join-Path $repoRoot "node_modules\tsx\dist\cli.mjs"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $tsxCliPath)) {
  throw "Missing tsx CLI at $tsxCliPath. Run npm install first."
}
if (-not (Test-Path -LiteralPath $runnerScript)) {
  throw "Missing repo Face heartbeat runner at $runnerScript."
}

Push-Location $repoRoot
try {
  & $nodePath $tsxCliPath $runnerScript
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
