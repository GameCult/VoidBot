Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$tempRoot = Join-Path $env:TEMP ("void-rumination-nap-skip-fixture-" + [guid]::NewGuid().ToString("n"))
$stateFilePath = Join-Path $tempRoot "void-self-state.cc"
$cursorOperationPath = Join-Path $tempRoot "cursor.json"
$sleepOperationPath = Join-Path $tempRoot "sleep-cycle.json"
$fixtureStatusDir = Join-Path $tempRoot "status"
$fixtureLogDir = Join-Path $tempRoot "logs"
$statusPath = Join-Path $fixtureStatusDir "moderation-rumination.json"
$operationOutputPath = Join-Path $fixtureStatusDir "moderation-rumination-operations.json"

New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

try {
  $cursorOperation = @{
    operation = "record_reviewed_messages"
    lastReviewedMessageId = "fixture-future-cursor"
    lastReviewedTimestamp = "2099-05-17T00:00:00.000Z"
  }
  $sleepOperation = @{
    operation = "update_sleep_cycle"
    sleepCycle = @{
      isNapping = $true
      currentNapStartedAt = "2026-05-17T03:00:00.000Z"
      currentNapEndsAt = "2099-05-17T04:00:00.000Z"
      nextNapStartsAt = "2099-05-17T07:00:00.000Z"
      activeDreamThemes = @("fixture-nap-skip")
    }
  }

  $cursorOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $cursorOperationPath -Encoding UTF8
  $sleepOperation | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $sleepOperationPath -Encoding UTF8
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $cursorOperationPath | Out-Null
  node .\scripts\void-self-state.mjs apply-operation --canonical $stateFilePath --operation-file $sleepOperationPath | Out-Null

  $previousCodexExecutable = $env:CODEX_EXECUTABLE
  $previousStatusDir = $env:VOID_RUMINATION_STATUS_DIR
  $previousLogDir = $env:VOID_RUMINATION_LOG_DIR

  try {
    $env:CODEX_EXECUTABLE = "this-command-should-not-run-during-nap-skip"
    $env:VOID_RUMINATION_STATUS_DIR = $fixtureStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $fixtureLogDir

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-void-moderator-rumination.ps1 -StateFilePath $stateFilePath | Out-Null
  } finally {
    $env:CODEX_EXECUTABLE = $previousCodexExecutable
    $env:VOID_RUMINATION_STATUS_DIR = $previousStatusDir
    $env:VOID_RUMINATION_LOG_DIR = $previousLogDir
  }

  $status = Get-Content -LiteralPath $statusPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($status.status -ne "skipped" -or $status.reason -ne "napping_without_room_debt") {
    throw "Nap skip fixture expected skipped/napping_without_room_debt."
  }

  $operations = Get-Content -LiteralPath $operationOutputPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($operations).Count -ne 0) {
    throw "Nap skip fixture expected no operation proposals."
  }

  @{
    status = "ok"
    runnerStatus = $status.status
    reason = $status.reason
    proposedOperationCount = @($operations).Count
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
