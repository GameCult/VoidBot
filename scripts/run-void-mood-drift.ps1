Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$statusDir = Join-Path $repoRoot ".voidbot\status"
$logDir = Join-Path $repoRoot ".voidbot\logs"
$statusPath = Join-Path $statusDir "void-mood-drift-run.json"
$logPath = Join-Path $logDir "void-mood-drift.log"
$scriptPath = Join-Path $PSScriptRoot "simulate-void-mood.mjs"

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,
    [Parameter(Mandatory = $true)]
    $Data
  )

  $directory = Split-Path -Parent $Path

  if (-not [string]::IsNullOrWhiteSpace($directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }

  $json = $Data | ConvertTo-Json -Depth 10
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

function Append-RunLog {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Line
  )

  $timestamped = "[{0}] {1}" -f ([DateTime]::UtcNow.ToString("o")), $Line
  Add-Content -Path $logPath -Value $timestamped -Encoding UTF8
}

New-Item -ItemType Directory -Force -Path $statusDir, $logDir | Out-Null

$startedAt = [DateTime]::UtcNow

Write-JsonFile -Path $statusPath -Data @{
  status = "running"
  startedAt = $startedAt.ToString("o")
  scriptPath = $scriptPath
}

$output = & node $scriptPath 2>&1
$exitCode = $LASTEXITCODE
$finishedAt = [DateTime]::UtcNow
$combined = ($output | Out-String).Trim()

Write-JsonFile -Path $statusPath -Data @{
  status = if ($exitCode -eq 0) { "ok" } else { "failed" }
  startedAt = $startedAt.ToString("o")
  finishedAt = $finishedAt.ToString("o")
  durationSeconds = [Math]::Round(($finishedAt - $startedAt).TotalSeconds, 2)
  exitCode = $exitCode
  output = $combined
  scriptPath = $scriptPath
}

Append-RunLog ("exit={0} output={1}" -f $exitCode, $combined)

if ($exitCode -ne 0) {
  throw "Void mood drift failed with exit code $exitCode. $combined"
}
